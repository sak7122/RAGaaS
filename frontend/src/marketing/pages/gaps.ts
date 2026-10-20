// @ts-nocheck — ported 1:1 from the design/proto/gaps.html prototype (DOM-scripted page).
// Runs once per mount; everything it starts is registered on `life` and undone on unmount.
import type { Life } from "../life";
import type { Motion } from "../motion";
import { clamp, smooth } from "../life";

export function init(root: HTMLElement, life: Life, m: Motion) {
  let tt = 0;

const RAG = { reduce: m.reduce, scrub: m.scrub, observe: m.observe, smooth, clamp };
/* ---------- live board: questions arrive, counts tick, rows re-rank ---------- */
const GAPS = [
  { t: 'What is the parking policy?', n: 9 }, { t: 'How do I expense a client dinner?', n: 7 },
  { t: 'Who covers on-call over the holidays?', n: 6 }, { t: 'Can I work from another country for a month?', n: 4 },
  { t: 'Where is the logo pack?', n: 3 }, { t: 'Is there a gym allowance?', n: 2 },
];
const ROW_H = innerWidth < 860 ? 76 : 68;
const rowsEl = document.getElementById('rows'), total = document.getElementById('total'), toast = document.getElementById('toast');
rowsEl.style.height = GAPS.length * ROW_H + 'px';
const rows = GAPS.map((g, i) => {
  const el = document.createElement('div'); el.className = 'grow-row';
  el.innerHTML = `<span class="rank"></span><span class="q"></span><span class="track"><span class="fill"></span></span><span class="n mono"></span><button type="button" class="write">Write the doc</button>`;
  el.querySelector('.q').textContent = g.t;
  rowsEl.appendChild(el);
  const r = { ...g, id: i, done: false, el };
  el.querySelector('.write').onclick = () => {
    if (r.done) return; r.done = true; el.classList.add('done'); el.querySelector('.write').textContent = 'Drafted';
    document.getElementById('toast-t').textContent = `Draft started: ${g.t.replace('?', '')}`;
    toast.classList.add('is-on'); clearTimeout(tt); tt = life.timeout(() => toast.classList.remove('is-on'), 2200);
    layout();
  };
  return r;
});
const layout = (bumped) => {
  const ranked = [...rows].sort((a, b) => (a.done - b.done) || (b.n - a.n));
  const max = Math.max(...rows.filter((r) => !r.done).map((r) => r.n), 1);
  ranked.forEach((r, i) => {
    r.el.style.transform = `translateY(${i * ROW_H}px)`;
    r.el.querySelector('.rank').textContent = r.done ? '–' : i + 1;
    r.el.querySelector('.fill').style.transform = `scaleX(${(r.n / max).toFixed(3)})`;
    const n = r.el.querySelector('.n');
    if (n.textContent !== String(r.n)) { n.textContent = r.n; if (r === bumped && !RAG.reduce) { n.classList.remove('pop'); void n.offsetWidth; n.classList.add('pop'); } }
    r.el.classList.toggle('bump', r === bumped);
  });
  total.textContent = `${rows.reduce((a, r) => a + r.n, 0)} questions this week`;
};
layout();
// a new ask lands every ~1.6s while the board is on screen; weighted toward lower rows so ranks change
let timer = 0, onScreen = false;
const tick = () => {
  const open = rows.filter((r) => !r.done); if (!open.length) return;
  const pick = open[Math.floor(Math.pow(Math.random(), 0.7) * open.length)];
  pick.n += 1 + (Math.random() < 0.3 ? 1 : 0);
  layout(pick);
  life.timeout(() => pick.el.classList.remove('bump'), 700);
};
const boardIo = new IntersectionObserver(([e]) => {
  onScreen = e.isIntersecting; clearInterval(timer);
  if (onScreen && !RAG.reduce) timer = life.interval(tick, 1600);
});
boardIo.observe(rowsEl);
life.observe(boardIo);

/* ---------- the loop: scrubbed through three states ---------- */
const lsteps = [...document.querySelectorAll('.lstep')], scs = [...document.querySelectorAll('.sc')];
const setLoop = (i) => { lsteps.forEach((s, j) => s.classList.toggle('is-on', j === i)); scs.forEach((s, j) => s.classList.toggle('is-on', j === i)); };
setLoop(0);
if (matchMedia('(max-width: 860px)').matches || RAG.reduce) {
  // no pin: advance as each step scrolls into view
  lsteps.forEach((s, i) => { s.dataset.once = ''; s.addEventListener('reveal', () => setLoop(i)); RAG.observe(s); });
} else RAG.scrub(document.getElementById('loop'), (p) => setLoop(p < 0.33 ? 0 : p < 0.66 ? 1 : 2));

}
