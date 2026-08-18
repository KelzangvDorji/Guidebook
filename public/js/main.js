(function () {
  const toggle = document.getElementById('navToggle');
  const links = document.getElementById('navLinks');
  if (toggle && links) {
    toggle.addEventListener('click', () => links.classList.toggle('open'));
  }
})();

(function () {
  const wrap = document.getElementById('bestSellerSlider');
  const track = wrap && wrap.querySelector('.slider-track');
  const dots = wrap ? Array.from(wrap.querySelectorAll('.dot')) : [];
  if (!wrap || !track || dots.length < 2) return;

  const total = dots.length;
  let index = 0;
  let timer = null;

  function show(i) {
    index = (i + total) % total;
    track.style.transform = 'translateX(-' + index * 100 + '%)';
    dots.forEach((dot, di) => dot.classList.toggle('active', di === index));
  }

  function start() {
    stop();
    timer = setInterval(() => show(index + 1), 1500);
  }
  function stop() {
    if (timer) clearInterval(timer);
  }

  dots.forEach((dot, i) => {
    dot.addEventListener('click', () => { show(i); start(); });
  });
  wrap.addEventListener('mouseenter', stop);
  wrap.addEventListener('mouseleave', start);
  wrap.addEventListener('focusin', stop);
  wrap.addEventListener('focusout', start);

  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) start();
})();

(function () {
  document.querySelectorAll('.pw-toggle').forEach((btn) => {
    const input = document.getElementById(btn.getAttribute('data-target'));
    if (!input) return;
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', String(show));
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
  });
})();

(function () {
  const btn = document.getElementById('backToTop');
  if (!btn) return;
  function sync() {
    btn.classList.toggle('visible', window.scrollY > 420);
  }
  window.addEventListener('scroll', sync, { passive: true });
  btn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  });
  sync();
})();
