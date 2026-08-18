import { getDocument, GlobalWorkerOptions } from '/public/vendor/pdfjs/pdf.min.mjs';

GlobalWorkerOptions.workerSrc = '/public/vendor/pdfjs/pdf.worker.min.mjs';

const script = document.getElementById('readerScript');
const bookId = script.dataset.bookId;
const mode = script.dataset.mode || 'full';
const isPreview = mode === 'preview';
const csrf = script.dataset.csrf;
const readerName = script.dataset.name;
const readerContact = script.dataset.contact;

const root = document.getElementById('readerRoot');
const shield = document.getElementById('readerShield');

let pdfDoc = null;
let watermarkText = '';
let nextPageToRender = 1;
let rendering = false;

function computeScale(unscaledWidth) {
  const targetWidth = Math.min(document.documentElement.clientWidth - 32, 880);
  return Math.min(2, (targetWidth / unscaledWidth) * (window.devicePixelRatio || 1));
}

function makeWatermarkLayer() {
  const layer = document.createElement('div');
  layer.className = 'watermark-layer';
  for (let i = 0; i < 16; i++) {
    const span = document.createElement('span');
    span.textContent = watermarkText;
    layer.appendChild(span);
  }
  return layer;
}

async function renderPage(num) {
  const page = await pdfDoc.getPage(num);
  const unscaled = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: computeScale(unscaled.width) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = Math.floor(viewport.width / dpr) + 'px';
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;

  const shell = document.createElement('div');
  shell.className = 'page-shell';
  shell.style.width = Math.floor(viewport.width / dpr) + 'px';
  shell.appendChild(canvas);
  shell.appendChild(makeWatermarkLayer());
  root.appendChild(shell);
}

async function renderBatch(count) {
  if (rendering || !pdfDoc) return;
  rendering = true;
  const end = Math.min(pdfDoc.numPages, nextPageToRender + count - 1);
  for (let n = nextPageToRender; n <= end; n++) {
    await renderPage(n);
  }
  nextPageToRender = end + 1;
  rendering = false;
  if (nextPageToRender <= pdfDoc.numPages) attachSentinel();
}

function attachSentinel() {
  const sentinel = document.createElement('div');
  sentinel.style.height = '1px';
  root.appendChild(sentinel);
  const obs = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) {
      obs.disconnect();
      sentinel.remove();
      renderBatch(3);
    }
  }, { rootMargin: '700px' });
  obs.observe(sentinel);
}

function appendPreviewCta() {
  const cta = document.createElement('div');
  cta.className = 'page-shell';
  cta.style.width = '100%';
  cta.style.maxWidth = '480px';
  cta.style.background = '#241a12';
  cta.style.padding = '28px 22px';
  cta.style.textAlign = 'center';
  cta.style.color = '#f1e8d6';
  cta.innerHTML = `<h3 style="color:#f1e8d6; margin-bottom:8px;">End of preview</h3>
    <p style="color:#b6a88f; margin-bottom:18px;">Buy the full book to keep reading in the protected viewer.</p>
    <a href="/books/${bookId}" class="btn btn-gold">Buy the Full Book</a>`;
  root.appendChild(cta);
}

async function loadBook() {
  try {
    const tokenPath = isPreview ? `/api/preview/${bookId}/token` : `/api/reader/${bookId}/token`;
    const tokenRes = await fetch(tokenPath, {
      method: 'POST',
      headers: isPreview ? {} : { 'x-csrf-token': csrf },
    });
    if (!tokenRes.ok) throw new Error('token request failed');
    const tokenData = await tokenRes.json();

    const streamPath = isPreview
      ? `/api/preview/${bookId}/stream?token=${encodeURIComponent(tokenData.token)}`
      : `/api/reader/${bookId}/stream?token=${encodeURIComponent(tokenData.token)}`;
    const streamRes = await fetch(streamPath, { cache: 'no-store' });
    if (!streamRes.ok) throw new Error('stream request failed');
    const buf = await streamRes.arrayBuffer();

    watermarkText = isPreview
      ? 'PREVIEW COPY · Bhutan Reads · not for distribution'
      : `${readerName} · ${readerContact} · Purchase #${tokenData.watermark.purchaseId}`;

    pdfDoc = await getDocument({ data: buf }).promise;
    root.innerHTML = '';
    // Preview PDFs are already truncated server-side to a handful of pages,
    // so render them all at once rather than lazily batching.
    await renderBatch(isPreview ? pdfDoc.numPages : 3);
    if (isPreview) appendPreviewCta();
  } catch (e) {
    root.innerHTML = '<div class="reader-loading">Unable to load this book. Please try again.</div>';
  }
}

loadBook();

/* ---- Best-effort, browser-level anti-capture heuristics ----
   These cannot stop OS-level screenshots, another camera, or dedicated
   recording software - they only react to signals a web page can observe. */
let shieldTimer = null;
function triggerShield(ms) {
  shield.classList.add('active');
  clearTimeout(shieldTimer);
  shieldTimer = setTimeout(() => shield.classList.remove('active'), ms);
}

document.addEventListener('keyup', (e) => {
  if (e.key === 'PrintScreen') {
    triggerShield(5000);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText('').catch(() => {});
    }
  }
});

document.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  const blockedCombo = (e.ctrlKey || e.metaKey) && ['s', 'p', 'u'].includes(k);
  const devtoolsCombo = (e.ctrlKey && e.shiftKey && k === 'i') || k === 'f12';
  if (blockedCombo || devtoolsCombo) e.preventDefault();
});

document.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('blur', () => triggerShield(2500));
window.addEventListener('focus', () => shield.classList.remove('active'));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) triggerShield(60000);
  else shield.classList.remove('active');
});
