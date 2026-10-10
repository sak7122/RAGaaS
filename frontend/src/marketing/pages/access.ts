// @ts-nocheck — ported 1:1 from the design/proto/access.html prototype (DOM-scripted page).
// Runs once per mount; everything it starts is registered on `life` and undone on unmount.
import type { Life } from "../life";
import type { Motion } from "../motion";
import { clamp, smooth } from "../life";

export function pre(root: HTMLElement) {

// Document grid is data; build it before motion.js wires the stagger.
const DOCS = [
  ['Company handbook', 'Everyone', 'sales eng hr'], ['Sales playbook', 'Sales team', 'sales'], ['Pricing sheet', 'Sales team', 'sales'],
  ['Deploy runbook', 'Engineering', 'eng'], ['Incident playbook', 'Engineering', 'eng'], ['Benefits overview', 'Everyone', 'sales eng hr'],
  ['Payroll bands', 'HR only', 'hr'], ['Board minutes', 'Restricted clearance', ''],
];
const grid = document.getElementById('grid');
DOCS.forEach(([t, who, allow]) => {
  const d = document.createElement('div'); d.className = 'doc'; d.dataset.allow = allow;
  d.innerHTML = '<span class="flash"></span><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#f5f5f7" stroke-width="1.6" aria-hidden="true"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/></svg><p style="margin:0;font-weight:600;font-size:17px"></p><p class="body" style="font-size:14px"></p><span class="st"></span>';
  d.children[2].textContent = t; d.children[3].textContent = who; grid.appendChild(d);
});

}

export function init(root: HTMLElement, life: Life, m: Motion) {
  let tt = 0;
  const grid = document.getElementById('grid');

const RAG = { reduce: m.reduce, scrub: m.scrub, observe: m.observe, smooth, clamp };
const LOCK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
const OK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>';
const segs = [...document.querySelectorAll('#segs .seg')], thumb = document.getElementById('thumb'), cnt = document.getElementById('cnt');
const docs = [...grid.children];
let shown = 0;
const countTo = (n) => {
  const from = shown; shown = n; const t0 = performance.now();
  if (RAG.reduce) { cnt.textContent = n; return; }
  const step = (now) => { const p = Math.min(1, (now - t0) / 400); cnt.textContent = Math.round(from + (n - from) * p); if (p < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
};
const setRole = (r, i, first) => {
  segs.forEach((s, j) => s.setAttribute('aria-pressed', i === j));
  thumb.style.transform = `translateX(${i * 100}%)`;
  let n = 0;
  docs.forEach((d, j) => {
    const ok = d.dataset.allow.split(' ').includes(r); if (ok) n++;
    const changed = d.classList.contains('locked') === ok;
    d.style.transitionDelay = first ? '' : `${j * 40}ms`;
    d.classList.toggle('locked', !ok);
    const st = d.querySelector('.st'); st.className = 'st ' + (ok ? 'ok' : 'no'); st.innerHTML = (ok ? OK : LOCK) + (ok ? 'Can answer' : 'Never searched');
    if (changed && !first) { d.classList.remove('changed'); void d.offsetWidth; d.classList.add('changed'); }
  });
  countTo(n);
};
segs.forEach((b, i) => b.onclick = () => setRole(b.dataset.r, i));
setRole('sales', 0, true);

/* ---------- check before search, scrubbed ---------- */
const phases = [...document.querySelectorAll('.phase')];
const filter = document.getElementById('filter'), sweep = document.getElementById('sweep'), ans = document.getElementById('labans');
const lab = document.getElementById('lab'), lds = [...document.querySelectorAll('.ld')];
const draw = (p) => {
  const ph = p < 0.34 ? 0 : p < 0.67 ? 1 : 2;
  phases.forEach((x, j) => x.classList.toggle('is-on', j === ph));
  const a = RAG.smooth(0.05, 0.3, p), b = RAG.smooth(0.38, 0.62, p), c = RAG.smooth(0.7, 0.85, p);
  const h = lab.clientHeight;
  filter.style.transform = `translate3d(0, ${(a * (h - 200)).toFixed(1)}px, 0)`;
  filter.style.opacity = (1 - RAG.smooth(0.3, 0.38, p)).toFixed(3);
  lds.forEach((d) => {
    if (d.classList.contains('cut')) { d.style.opacity = (1 - 0.85 * a).toFixed(3); d.style.transform = `scale(${(1 - 0.08 * a).toFixed(3)})`; }
    if (d.classList.contains('hitme')) d.classList.toggle('hit', b > 0.55);
  });
  sweep.style.opacity = (b > 0 && b < 1 ? 1 : 0);
  sweep.style.transform = `translate3d(${(20 + b * (lab.clientWidth - 40)).toFixed(1)}px,0,0)`;
  ans.style.opacity = c.toFixed(3);
  ans.style.transform = `translate3d(0, ${(16 * (1 - c)).toFixed(1)}px, 0)`;
};
if (RAG.reduce || matchMedia('(max-width: 860px)').matches) {
  // no pin: show the end state, phases all readable
  draw(1); phases.forEach((x) => x.classList.add('is-on'));
} else RAG.scrub(document.getElementById('cbs'), draw);

}
