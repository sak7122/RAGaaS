// @ts-nocheck — ported 1:1 from the design/proto/ask.html prototype (DOM-scripted page).
// Runs once per mount; everything it starts is registered on `life` and undone on unmount.
import type { Life } from "../life";
import type { Motion } from "../motion";
import { clamp, smooth } from "../life";

import { initChat } from "../askChat";

export function init(root: HTMLElement, life: Life, m: Motion) {
const RAG = { reduce: m.reduce, scrub: m.scrub, observe: m.observe, smooth, clamp };

/* ---------- hero ---------- */
const section = document.getElementById('flight');
const caps = [...document.querySelectorAll('.cap')];
const huds = [...document.querySelectorAll('.hud-i')];
const dots = [...document.querySelectorAll('.rail .dot')];
const card = document.getElementById('answer-card');
const hint = document.getElementById('hint');
const setBeat = (b) => {
  caps.forEach((c, i) => c.classList.toggle('is-on', i === b));
  huds.forEach((h, i) => h.classList.toggle('is-on', i === b));
  dots.forEach((d, i) => { d.classList.toggle('is-on', i === b); d.classList.toggle('is-past', i < b); });
  card.classList.toggle('is-on', b === 4);
};
setBeat(0);
// three.js is loaded only here, after the page is on screen; captions work without it.
const noWebgl = () => {
  document.querySelector('.stage')?.classList.add('no-webgl');
  RAG.scrub(section, (p) => setBeat([0.13, 0.36, 0.57, 0.78].filter((s) => p >= s).length));
};
import("../flight").then(({ initFlight }) => {
  if (!life.alive()) return;
  const flight = initFlight({
    section, canvas: document.getElementById('scene'),
    labels: { origin: document.getElementById('tag-origin'), gate: document.getElementById('tag-gate'), matches: [1, 2, 3].map((i) => document.getElementById('tag-' + i)) },
    onBeat: setBeat,
    onProgress: (p) => { hint.style.opacity = p > 0.02 ? 0 : 1; },
  });
  if (flight) life.add(() => flight.dispose()); else noWebgl();
}).catch(noWebgl);

/* ---------- chat + document picker: assets/ask-chat.js ---------- */
initChat(life, m.reduce);

/* ---------- pipeline: a packet travels the wire as you scroll ---------- */
const stages = [...document.querySelectorAll('.stg')];
const wire = document.getElementById('wire-on'), packet = document.getElementById('packet'), board = document.getElementById('board');
const nodes = [...board.querySelectorAll('.node')];
const pts = [[16, 16], [50, 16], [50, 38], [50, 58], [84, 58], [84, 80]];
const segL = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
const total = segL.reduce((a, b) => a + b, 0);
const at = (f) => { let d = f * total; for (let i = 0; i < segL.length; i++) { if (d <= segL[i]) { const k = d / segL[i]; return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k]; } d -= segL[i]; } return pts[pts.length - 1]; };
const drawPipe = (p) => {
  const f = RAG.smooth(0.08, 0.92, p);
  wire.style.strokeDashoffset = (1 - f).toFixed(4);
  const [x, y] = at(f); const w = board.clientWidth, h = board.clientHeight;
  packet.style.transform = `translate3d(${(x / 100 * w).toFixed(1)}px, ${(y / 95 * h).toFixed(1)}px, 0)`;
  const step = f <= 0 ? 0 : Math.min(3, Math.floor(f * 3.999));
  stages.forEach((st, i) => { st.classList.toggle('is-on', i === step); st.classList.toggle('is-past', i < step); });
  nodes.forEach((n, i) => n.classList.toggle('is-on', i === step));
};
if (matchMedia('(max-width: 860px)').matches) { RAG.scrub(board, drawPipe); } else RAG.scrub(document.getElementById('how'), drawPipe);

}
