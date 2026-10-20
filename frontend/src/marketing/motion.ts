// Shared motion for the marketing pages (ported from design/proto/assets/motion.js).
//  [data-reveal] / [data-stagger] / [data-wipe] / [data-split] / [data-once] get .is-in once,
//  the first time they're seen, and fire a "reveal" event.
//  [data-count] counts up when revealed. [data-parallax] drifts with scroll (transform only).
//  scrub(el, fn) calls fn with the element's 0..1 scroll progress, once per frame at most.
import { Life, clamp, reducedMotion } from "./life";

export type Motion = {
  reduce: boolean;
  scrub: (el: Element, fn: (p: number) => void) => void;
  observe: (el: Element) => void;
};

export function initMotion(root: HTMLElement, life: Life): Motion {
  const reduce = reducedMotion();

  // Split headlines into words that rise from a mask (screen readers get the whole line).
  root.querySelectorAll<HTMLElement>("[data-split]").forEach((el) => {
    let i = 0;
    const walk = (node: Node) => {
      [...node.childNodes].forEach((n) => {
        if (n.nodeType === Node.TEXT_NODE) {
          const frag = document.createDocumentFragment();
          (n.textContent ?? "").split(/(\s+)/).forEach((part) => {
            if (!part) return;
            if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); return; }
            const w = document.createElement("span"); w.className = "w"; w.setAttribute("aria-hidden", "true");
            const s = document.createElement("span"); s.textContent = part; s.style.setProperty("--i", String(i++));
            w.appendChild(s); frag.appendChild(w);
          });
          n.replaceWith(frag);
        } else if (n.nodeType === Node.ELEMENT_NODE && (n as Element).tagName !== "BR") walk(n);
      });
    };
    el.setAttribute("aria-label", (el.textContent ?? "").replace(/\s+/g, " ").trim());
    walk(el);
  });
  root.querySelectorAll<HTMLElement>("[data-stagger]").forEach((el) =>
    [...el.children].forEach((c, i) => (c as HTMLElement).style.setProperty("--i", String(i))));

  const countUp = (el: HTMLElement) => {
    const raw = el.dataset.count ?? "0";
    const end = parseFloat(raw), dec = (raw.split(".")[1] || "").length;
    if (reduce) { el.textContent = end.toFixed(dec); return; }
    const t0 = performance.now(), dur = +(el.dataset.dur || 1400);
    const tick = (now: number) => {
      if (!life.alive()) return;
      const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 4);
      el.textContent = (end * e).toFixed(dec);
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      const t = e.target as HTMLElement;
      t.classList.add("is-in");
      t.querySelectorAll<HTMLElement>("[data-count]").forEach(countUp);
      if (t.dataset.count) countUp(t);
      t.dispatchEvent(new CustomEvent("reveal"));
      io.unobserve(t);
    });
  }, { threshold: 0.18, rootMargin: "0px 0px -60px 0px" });
  life.observe(io);
  root.querySelectorAll("[data-reveal],[data-stagger],[data-split],[data-once]").forEach((el) => io.observe(el));
  // A fully clipped element has no visible area, so it never intersects: watch its parent instead.
  root.querySelectorAll<HTMLElement>("[data-wipe]").forEach((el) => {
    const w = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { el.classList.add("is-in"); w.disconnect(); }
    }, { threshold: 0.1 });
    life.observe(w);
    if (el.parentElement) w.observe(el.parentElement);
  });

  // Scroll-linked work: one rAF per frame, only while something is on screen.
  const para = [...root.querySelectorAll<HTMLElement>("[data-parallax]")];
  const scrubs: { el: Element; fn: (p: number) => void; last: number }[] = [];
  let ticking = false;
  const frame = () => {
    ticking = false;
    if (!life.alive()) return;
    const vh = innerHeight;
    if (!reduce) para.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.bottom < -200 || r.top > vh + 200) return;
      const k = parseFloat(el.dataset.parallax ?? "0");
      el.style.transform = `translate3d(0, ${((r.top + r.height / 2 - vh / 2) * -k).toFixed(1)}px, 0)`;
    });
    scrubs.forEach((s) => {
      const r = s.el.getBoundingClientRect();
      const span = r.height - vh;
      const p = span > 0 ? clamp(-r.top / span) : clamp((vh - r.top) / (vh + r.height));
      const q = Math.round(p * 1000) / 1000;
      if (q !== s.last) { s.last = q; s.fn(q); }
    });
  };
  const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(frame); } };
  life.on(window, "scroll", onScroll, { passive: true });
  life.on(window, "resize", onScroll);
  requestAnimationFrame(frame);

  return {
    reduce,
    scrub(el, fn) { scrubs.push({ el, fn, last: -1 }); onScroll(); },
    observe(el) { io.observe(el); },
  };
}
