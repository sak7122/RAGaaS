// Shared motion for the RAGaaS prototypes.
//  [data-reveal] / [data-stagger] / [data-wipe] / [data-split] get .is-in once, the first time they're seen.
//  [data-count="1234"] counts up once revealed.  [data-parallax="0.15"] drifts with scroll (transform only).
//  [data-scrub] gets its own 0..1 scroll progress written as transforms by a callback (window.RAG.scrub).
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const RAG = (window.RAG = window.RAG || {});
  RAG.reduce = reduce;
  RAG.clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  RAG.smooth = (a, b, x) => { const t = RAG.clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };

  // Split headlines into words that rise from a mask.
  document.querySelectorAll('[data-split]').forEach((el) => {
    let i = 0;
    const walk = (node) => {
      [...node.childNodes].forEach((n) => {
        if (n.nodeType === 3) {
          const frag = document.createDocumentFragment();
          n.textContent.split(/(\s+)/).forEach((part) => {
            if (!part) return;
            if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); return; }
            const w = document.createElement('span'); w.className = 'w';
            const s = document.createElement('span'); s.textContent = part; s.style.setProperty('--i', i++);
            w.appendChild(s); frag.appendChild(w);
          });
          n.replaceWith(frag);
        } else if (n.nodeType === 1 && n.tagName !== 'BR') walk(n);
      });
    };
    el.setAttribute('aria-label', el.textContent.replace(/\s+/g, ' ').trim());
    walk(el);
    el.querySelectorAll('.w').forEach((w) => w.setAttribute('aria-hidden', 'true'));
  });
  document.querySelectorAll('[data-stagger]').forEach((el) => [...el.children].forEach((c, i) => c.style.setProperty('--i', i)));

  const countUp = (el) => {
    const end = parseFloat(el.dataset.count); const dec = (el.dataset.count.split('.')[1] || '').length;
    if (reduce) { el.textContent = end.toFixed(dec); return; }
    const t0 = performance.now(), dur = +(el.dataset.dur || 1400);
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 4);
      el.textContent = (end * e).toFixed(dec);
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      e.target.classList.add('is-in');
      e.target.querySelectorAll('[data-count]').forEach(countUp);
      if (e.target.dataset.count) countUp(e.target);
      e.target.dispatchEvent(new CustomEvent('reveal'));
      io.unobserve(e.target);
    });
  }, { threshold: 0.18, rootMargin: '0px 0px -60px 0px' });
  RAG.observe = (el) => io.observe(el);
  document.querySelectorAll('[data-reveal],[data-stagger],[data-split],[data-once]').forEach((el) => io.observe(el));
  // A fully clipped element has no visible area, so it never intersects: watch its parent instead.
  document.querySelectorAll('[data-wipe]').forEach((el) => {
    const w = new IntersectionObserver(([e]) => { if (e.isIntersecting) { el.classList.add('is-in'); w.disconnect(); } }, { threshold: 0.1 });
    w.observe(el.parentElement);
  });

  // Scroll-linked work, one rAF per frame, only while something is on screen.
  const para = [...document.querySelectorAll('[data-parallax]')];
  const scrubs = [];
  RAG.scrub = (el, fn) => scrubs.push({ el, fn, last: -1 });
  let ticking = false;
  const frame = () => {
    ticking = false;
    const vh = innerHeight;
    if (!reduce) para.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.bottom < -200 || r.top > vh + 200) return;
      const k = parseFloat(el.dataset.parallax);
      el.style.transform = `translate3d(0, ${((r.top + r.height / 2 - vh / 2) * -k).toFixed(1)}px, 0)`;
    });
    scrubs.forEach((s) => {
      const r = s.el.getBoundingClientRect();
      const span = r.height - vh;
      const p = span > 0 ? RAG.clamp(-r.top / span) : RAG.clamp((vh - r.top) / (vh + r.height));
      const q = Math.round(p * 1000) / 1000;
      if (q !== s.last) { s.last = q; s.fn(q); }
    });
  };
  const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(frame); } };
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onScroll);
  RAG.kick = onScroll;
  requestAnimationFrame(frame);
})();
