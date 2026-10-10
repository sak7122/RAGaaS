// @ts-nocheck — ported 1:1 from the design/proto/academy.html prototype (DOM-scripted page).
// Runs once per mount; everything it starts is registered on `life` and undone on unmount.
import type { Life } from "../life";
import type { Motion } from "../motion";
import { clamp, smooth } from "../life";

export function init(root: HTMLElement, life: Life, m: Motion) {
  let tt = 0;

const RAG = { reduce: m.reduce, scrub: m.scrub, observe: m.observe, smooth, clamp };
const TICK = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>';
/* ---------- hero path: lessons tick in sequence once the card is seen ---------- */
const LESSONS = [['Welcome to Acme', 4], ['Discounts and approvals', 6], ['Logging calls in the CRM', 5], ['Your first quote', 7]];
const lessonsEl = document.getElementById('lessons');
LESSONS.forEach(([t, m], i) => {
  const d = document.createElement('div'); d.className = 'lesson ' + (i === 0 ? 'current' : 'locked');
  d.innerHTML = `<span class="tick">${TICK}</span><span style="flex:1"></span><span class="meta">${m} min</span>`;
  d.children[1].textContent = t; lessonsEl.appendChild(d);
});
const ring = document.getElementById('ring'), ringT = document.getElementById('ring-t');
const setDone = (n) => {
  [...lessonsEl.children].forEach((d, i) => {
    const tick = d.querySelector('.tick');
    const was = tick.classList.contains('done');
    tick.classList.toggle('done', i < n);
    if (i < n && !was && !RAG.reduce) { tick.classList.add('just'); }
    d.className = 'lesson ' + (i < n ? '' : i === n ? 'current' : 'locked');
    d.querySelector('.meta').textContent = i < n ? 'Passed' : `${LESSONS[i][1]} min`;
  });
  ring.style.strokeDashoffset = (276.46 * (1 - n / LESSONS.length)).toFixed(2);
  ringT.textContent = `${n}/${LESSONS.length}`;
};
document.getElementById('path').addEventListener('reveal', () => {
  if (RAG.reduce) return setDone(3);
  [1, 2, 3].forEach((n, k) => life.timeout(() => setDone(n), 700 + k * 650));
});

/* ---------- quiz ---------- */
const QUIZ = [
  { q: 'Where is the staff wifi password posted?', o: ['In the onboarding email', 'At reception, every Friday', 'On the intranet home page'], r: 1, why: 'It rotates every Friday and is posted at reception.', src: 'Company handbook, p. 11' },
  { q: 'A customer asks for 20% off an annual plan. What do you do?', o: ['Approve it yourself to close the deal', "Get the sales director's approval and log it in the CRM", "Say discounts aren't allowed"], r: 1, why: "Anything above 15 percent needs the sales director's approval, logged in the CRM.", src: 'Sales playbook, p. 4' },
  { q: 'When should a call be logged in the CRM?', o: ['The same day', 'By the end of the week', 'Only when a deal closes'], r: 0, why: 'Every call is logged the same day.', src: 'CRM guide, p. 7' },
];
const box = document.getElementById('quizbox');
let qi = 0;
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function renderQ() {
  if (qi >= QUIZ.length) {
    box.innerHTML = `<div class="cert"><p class="body" style="font-size:13px">Certificate of completion</p><p class="h3" style="margin:10px 0 4px">Sales onboarding</p><p class="body">3 of 3 tests passed. Waiting for manager sign-off.</p><div style="margin-top:18px;position:relative;z-index:1"><button type="button" class="pill pill-ghost pill-sm" id="restart">Start over</button></div></div>`;
    document.getElementById('restart').onclick = () => { qi = 0; renderQ(); };
    return;
  }
  const Q = QUIZ[qi];
  box.innerHTML = `<div class="qbar" aria-hidden="true">${QUIZ.map((_, i) => `<i class="${i < qi ? 'on' : ''}"></i>`).join('')}</div>
    <div class="swap" style="display:flex;flex-direction:column;gap:12px">
    <p class="body" style="font-size:14px">Lesson ${qi + 1} test</p>
    <p class="h3" style="font-size:22px;margin-bottom:6px">${esc(Q.q)}</p>
    ${Q.o.map((o, i) => `<button type="button" class="opt" data-i="${i}">${esc(o)}</button>`).join('')}
    <div id="fb"></div></div>`;
  box.querySelectorAll('.opt').forEach((b) => b.onclick = () => answer(+b.dataset.i));
}
function answer(i) {
  const Q = QUIZ[qi], right = i === Q.r;
  box.querySelectorAll('.opt').forEach((b, j) => { b.disabled = true; if (j === Q.r) b.classList.add('right'); else if (j === i) b.classList.add('wrong'); });
  const fb = document.getElementById('fb');
  fb.innerHTML = `<div class="feedback"><p class="body" style="color:var(--ink)">${right ? 'Right.' : 'Not quite.'} ${esc(Q.why)}</p><span class="chip" style="align-self:flex-start">${esc(Q.src)}</span><div class="row-btns">${right ? `<button type="button" class="pill pill-blue pill-sm" id="next">${qi === QUIZ.length - 1 ? 'Finish the path' : 'Next lesson'}</button>` : `<button type="button" class="pill pill-ghost pill-sm" id="retry">Try again</button><span class="body" style="font-size:13px;align-self:center">This one comes back for review in 3 days.</span>`}</div></div>`;
  if (right) { box.querySelectorAll('.qbar i')[qi].classList.add('on'); document.getElementById('next').onclick = () => { qi++; renderQ(); }; }
  else document.getElementById('retry').onclick = renderQ;
}
renderQ();

/* ---------- review timeline ---------- */
const DAYS = { 1: ['lesson-d', 'Lesson 1'], 2: ['lesson-d', ''], 3: ['lesson-d', 'Lesson 2'], 5: ['review', 'Review'], 6: ['lesson-d', 'Lesson 3'], 8: ['lesson-d', 'Lesson 4'], 10: ['review', ''], 12: ['review', 'Review again'], 14: ['signed', 'Sign-off'] };
const days = document.getElementById('days');
for (let d = 1; d <= 14; d++) {
  const el = document.createElement('div'); el.className = 'day'; el.style.setProperty('--i', d - 1);
  const k = DAYS[d];
  el.innerHTML = `${k && k[1] ? `<span class="dlabel" style="--i:${d - 1}">${k[1]}</span>` : ''}<span class="dot ${k ? k[0] : ''}" style="--i:${d - 1}"></span><span>Day ${d}</span>`;
  days.appendChild(el);
}

/* ---------- hold to sign off (deliberate press: slow fill, fast release) ---------- */
const sb = document.getElementById('signbtn');
let holdT = 0;
const start = (e) => { if (sb.classList.contains('signed')) return; sb.classList.add('pressing'); holdT = life.timeout(signed, RAG.reduce ? 0 : 1200); };
const cancel = () => { sb.classList.remove('pressing'); clearTimeout(holdT); };
function signed() {
  sb.classList.remove('pressing'); sb.classList.add('signed'); document.getElementById('sign-t').textContent = 'Signed off';
  document.getElementById('certslot').innerHTML = `<div class="cert" style="margin-top:6px"><p class="body" style="font-size:13px">Certificate of completion</p><p class="h3" style="margin:8px 0 4px">Priya · Sales onboarding</p><p class="body" style="font-size:14px">Company handbook v3 · Sales playbook v3 · CRM guide v2 · Pricing sheet v5</p></div>`;
}
sb.addEventListener('pointerdown', start); ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => sb.addEventListener(ev, cancel));
sb.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); start(); } });
sb.addEventListener('keyup', (e) => { if (e.key === 'Enter' || e.key === ' ') cancel(); });

}
