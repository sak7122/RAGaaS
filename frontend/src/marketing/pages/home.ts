// @ts-nocheck — ported 1:1 from the design/proto/index.html prototype (DOM-scripted page).
// Runs once per mount; everything it starts is registered on `life` and undone on unmount.
import type { Life } from "../life";
import type { Motion } from "../motion";
import { clamp, smooth } from "../life";

/** Builds DOM that motion.ts must see (stagger children). */
export function pre(root: HTMLElement) {

// FAQ content is data; build before motion.js wires the stagger.
const FAQS = [
  ['How is this different from ChatGPT?', 'It is shared by your whole team, it only answers from your own documents, every answer is cited, and it shows you the questions your documents keep failing to answer.'],
  ['Is my data private?', "Each workspace is isolated. Restricted documents are never searched for people who aren't cleared for them, and your documents are never used to train a model."],
  ['What files can I upload?', 'PDF and Word (.docx) today, up to 30 MB each.'],
  ['Can it onboard new hires?', 'Yes. Pick a role and its documents become a learning path with tests, spaced review, manager sign-off and a certificate.'],
  ['What does it cost?', 'There is a free tier. Paid plans are priced by seats and analytics: [YOUR PRICING].'],
];
const list = document.getElementById('faq-list');
FAQS.forEach(([q, a], i) => {
  const item = document.createElement('div'); item.className = 'faq-i';
  item.innerHTML = `<button type="button" class="faq-q" aria-expanded="${i === 0}" aria-controls="faq-${i}"><span></span><svg class="chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1d1d1f" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button><div id="faq-${i}" class="faq-a${i === 0 ? ' is-open' : ''}" role="region"><div class="faq-in"><p class="body" style="padding-bottom:22px;max-width:60ch"></p></div></div>`;
  item.querySelector('.faq-q span').textContent = q; item.querySelector('p').textContent = a;
  list.appendChild(item);
});
list.addEventListener('click', (e) => {
  const b = e.target.closest('.faq-q'); if (!b) return;
  const open = b.getAttribute('aria-expanded') !== 'true';
  list.querySelectorAll('.faq-q').forEach((x) => { x.setAttribute('aria-expanded', 'false'); x.nextElementSibling.classList.remove('is-open'); });
  if (open) { b.setAttribute('aria-expanded', 'true'); b.nextElementSibling.classList.add('is-open'); }
});

}

export function init(root: HTMLElement, life: Life, m: Motion) {
  let tt = 0;

const RAG = { reduce: m.reduce, scrub: m.scrub, observe: m.observe, smooth, clamp };
// segmented control: sliding thumb + cross-fading views
const segs = [...document.querySelectorAll('.segs:not(#role-segs) .seg')], thumb = document.getElementById('thumb');
const views = [...document.querySelectorAll('.view')], sides = [...document.querySelectorAll('.side-i')];
const titles = ['Ask', 'Knowledge gaps', 'Academy'];
segs.forEach((b, i) => b.onclick = () => {
  segs.forEach((x, j) => x.setAttribute('aria-pressed', i === j));
  thumb.style.transform = `translateX(${i * 100}%)`;
  views.forEach((v, j) => { v.classList.toggle('is-on', i === j); v.classList.toggle('grow', i === j); });
  sides.forEach((s, j) => s.classList.toggle('is-on', i === j));
  document.getElementById('vtitle').textContent = titles[i];
});
// product window settles from .86 to 1 over the first 560px of scroll
const win = document.getElementById('win');
if (!RAG.reduce) RAG.scrub(document.querySelector('.hero'), (p) => {
  const k = RAG.clamp(scrollY / 560);
  const e = 1 - Math.pow(1 - k, 2);
  win.style.transform = `scale(${(0.86 + 0.14 * e).toFixed(4)})`;
});
// pinned horizontal: cards slide sideways and the off-centre ones sit back slightly
const hs = document.getElementById('jobs'), track = document.getElementById('hs-track'), bar = document.getElementById('hs-bar'), count = document.getElementById('hs-count');
const cards = [...track.children];
const wide = () => !matchMedia('(max-width: 860px)').matches && !RAG.reduce;
RAG.scrub(hs, (p) => {
  if (!wide()) return;
  const f = RAG.smooth(0.04, 0.96, p);
  const dist = track.scrollWidth - innerWidth;
  track.style.transform = `translate3d(${(-dist * f).toFixed(1)}px,0,0)`;
  bar.style.transform = `scaleX(${f.toFixed(4)})`;
  const idx = f * (cards.length - 1);
  cards.forEach((c, i) => { const d = Math.min(1, Math.abs(i - idx)); c.style.transform = `scale(${(1 - d * 0.06).toFixed(4)})`; c.style.opacity = (1 - d * 0.35).toFixed(3); });
  count.textContent = `0${Math.round(idx) + 1} / 03`;
});
// gaps tile: bars grow once revealed
document.getElementById('gap-list').addEventListener('reveal', (e) => e.currentTarget.classList.add('grow'));
// ring
document.getElementById('ring-box').addEventListener('reveal', () => { document.getElementById('ring').style.strokeDashoffset = (276.46 / 3).toFixed(2); });
// role switch
const roleSegs = [...document.querySelectorAll('#role-segs .seg')], roleThumb = document.getElementById('role-thumb');
const docs = [...document.querySelectorAll('.dcard')];
const lockSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
const okSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>';
const setRole = (r, i) => {
  roleSegs.forEach((x, j) => { x.setAttribute('aria-pressed', i === j); x.style.color = i === j ? '#f5f5f7' : '#a1a1a6'; });
  roleThumb.style.transform = `translateX(${i * 100}%)`;
  docs.forEach((d, j) => {
    const ok = d.dataset.allow.split(' ').includes(r);
    d.style.transitionDelay = `${j * 50}ms`;
    d.classList.toggle('locked', !ok);
    let s = d.querySelector('.status'); if (!s) { s = document.createElement('span'); d.appendChild(s); }
    s.className = 'status ' + (ok ? 'okline' : 'lockline'); s.innerHTML = (ok ? okSvg : lockSvg) + (ok ? 'Can answer' : 'Never searched');
  });
};
roleSegs.forEach((b, i) => b.onclick = () => setRole(b.dataset.r, i));
setRole('sales', 0);

}
