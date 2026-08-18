(function () {
  function getCookie(name) {
    const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : '';
  }

  const buyBtn = document.getElementById('buyBtn');
  const modal = document.getElementById('payModal');
  if (!buyBtn || !modal) return;

  const closeBtn = document.getElementById('payClose');
  const confirmBtn = document.getElementById('payConfirmBtn');
  const refEl = document.getElementById('payRef');
  const statusEl = document.getElementById('payStatus');
  const actionsEl = document.getElementById('payActions');
  const detailsEl = document.getElementById('payDetails');

  const bookId = buyBtn.dataset.bookId;
  let currentPurchaseId = null;

  function openModal() {
    modal.classList.add('open');
    startPurchase();
  }
  function closeModal() {
    modal.classList.remove('open');
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': getCookie('csrf_token') },
      body: JSON.stringify(body || {}),
    });
    if (res.status === 401) {
      window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
      return { ok: false, status: 401, data: {} };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  async function startPurchase() {
    detailsEl.style.display = '';
    actionsEl.style.display = '';
    statusEl.style.display = 'none';
    refEl.textContent = 'Creating order…';
    confirmBtn.disabled = true;

    const { ok, data } = await api('/api/payments/create', { bookId: Number(bookId) });
    if (!ok) {
      if (data.alreadyOwned) {
        window.location.href = '/read/' + bookId;
        return;
      }
      refEl.textContent = 'Error';
      statusEl.style.display = 'block';
      statusEl.innerHTML = '<p>' + (data.error || 'Could not start checkout.') + '</p>';
      actionsEl.style.display = 'none';
      return;
    }

    currentPurchaseId = data.purchaseId;
    refEl.textContent = data.reference;
    confirmBtn.disabled = false;
  }

  async function confirmPurchase() {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Processing…';
    detailsEl.style.display = 'none';
    actionsEl.style.display = 'none';
    statusEl.style.display = 'block';
    statusEl.innerHTML = '<div class="spinner"></div><p>Verifying payment…</p>';

    const { ok, data } = await api('/api/payments/confirm', { purchaseId: currentPurchaseId });

    if (ok && data.status === 'completed') {
      statusEl.innerHTML = '<div class="spinner" style="border-top-color:#2c5c22;"></div><p>Payment confirmed. Opening your book…</p>';
      window.location.href = '/read/' + bookId;
    } else {
      statusEl.innerHTML = '<p>' + (data.error || 'Payment could not be confirmed.') + '</p>';
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Try Again';
      actionsEl.style.display = '';
      detailsEl.style.display = '';
    }
  }

  buyBtn.addEventListener('click', openModal);
  closeBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  confirmBtn.addEventListener('click', confirmPurchase);
})();
