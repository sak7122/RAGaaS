// @ts-nocheck — ported from design/proto/assets/ask-chat.js (demo chat + document picker on the public Ask page).
// Demo data only: the signed-in app uses the real picker (components/DocumentPicker.tsx).
import type { Life } from "./life";

/* ---------- demo workspace (what a sales hire can read) ---------- */
const DEMO_DOCS = [
  { file: 'sales_playbook.pdf', title: 'Sales playbook', pages: 18, updated: '2 days ago', who: 'Sales team',
    summary: 'How the sales team prices, discounts and quotes annual plans, and who has to approve what before a quote goes out.',
    questions: ['Can I offer 20% off an annual plan?', 'Who approves a discount above 15%?', 'When does a quote need legal review?', 'How long is a quote valid?'] },
  { file: 'company_handbook.pdf', title: 'Company handbook', pages: 42, updated: '3 weeks ago', who: 'Everyone',
    summary: 'Day-to-day life at Acme: office hours, wifi and building access, leave, holidays and who to ask for what.',
    questions: ['When does the wifi password change?', 'How many days of leave do I get?', 'Who do I ask for building access?'] },
  { file: 'pricing_sheet.docx', title: 'Pricing sheet', pages: 3, updated: '5 days ago', who: 'Sales team',
    summary: 'List prices for every plan and add-on, with the annual-billing rate and the discount bands reps can use.',
    questions: ['What does the Growth plan cost per seat?', 'What is the annual billing discount?', 'Which add-ons can be sold alone?'] },
  { file: 'crm_guide.pdf', title: 'CRM guide', pages: 12, updated: '1 month ago', who: 'Sales team',
    summary: 'How to log calls, move deals through stages and record approvals in the CRM so reporting stays accurate.',
    questions: ['When should a call be logged in the CRM?', 'How do I record a discount approval?', 'What are the deal stages?'] },
  { file: 'expense_policy.docx', title: 'Expense policy', pages: 6, updated: '2 months ago', who: 'Everyone',
    summary: 'What can be expensed, per-diem limits for travel, and how to submit receipts before the monthly cut-off.',
    questions: ['How do I expense a client lunch?', 'What is the hotel limit per night?', 'When is the monthly cut-off?'] },
  { file: 'benefits_overview.pdf', title: 'Benefits overview', pages: 9, updated: '4 months ago', who: 'Everyone',
    summary: 'Health cover, pension matching, the learning budget and how to enrol in each in your first month.',
    questions: ['How much is the learning budget?', 'When can I enrol in health cover?', 'Does the company match pension contributions?'] },
  { file: 'brand_guide.pdf', title: 'Brand guide', pages: 24, updated: '6 months ago', who: 'Everyone',
    summary: 'Logo use, colours, tone of voice and the slide template to use for customer-facing decks.',
    questions: ['Where is the slide template?', 'Can I change the logo colour?', 'How should we write product names?'] },
  { file: 'security_basics.docx', title: 'Security basics', pages: 5, updated: '1 month ago', who: 'Everyone',
    summary: 'Password manager, two-factor sign-in, what counts as customer data and how to report a lost laptop.',
    questions: ['How do I report a lost laptop?', 'Which password manager do we use?', 'Can I share customer data over email?'] },
];
// Answers with a real excerpt for the questions the demo knows; anything else gets a
// summary-based answer from the best-matching document.
const DEMO_QA = {
  'Can I offer 20% off an annual plan?': { file: 'sales_playbook.pdf', page: 4, a: "Only with the sales director's approval, logged in the CRM before you send the quote. Up to 15 percent needs no sign-off.",
    before: 'Reps may offer up to 15 percent on annual plans without sign-off. ', hl: 'Discounts above 15 percent need approval from the sales director', after: ' and must be recorded in the CRM before a quote is sent.' },
  'Who approves a discount above 15%?': { file: 'sales_playbook.pdf', page: 4, a: 'The sales director. The approval is recorded in the CRM before the quote goes out.',
    before: 'Reps may offer up to 15 percent on annual plans without sign-off. ', hl: 'Discounts above 15 percent need approval from the sales director', after: ' and must be recorded in the CRM before a quote is sent.' },
  'When does the wifi password change?': { file: 'company_handbook.pdf', page: 11, a: 'Every Friday. The new password is posted at reception.',
    before: 'Guests use the visitor network. ', hl: 'The staff wifi password rotates every Friday and is posted at reception', after: '. Never share it in email.' },
  'What is the annual billing discount?': { file: 'pricing_sheet.docx', page: 1, a: 'Annual billing is 15 percent below the monthly price on every plan.',
    before: 'All plans are billed monthly or annually. ', hl: 'Annual billing is 15 percent below the monthly list price', after: ', paid up front.' },
  'When should a call be logged in the CRM?': { file: 'crm_guide.pdf', page: 7, a: 'The same day. Every customer call is logged before you sign off.',
    before: 'Activity drives the forecast. ', hl: 'Log every customer call in the CRM on the same day', after: ', with next steps and the deal stage.' },
  'How do I record a discount approval?': { file: 'crm_guide.pdf', page: 9, a: "Attach the sales director's approval to the deal under Approvals, then request the quote.",
    before: 'Quotes with a discount above 15 percent are blocked until ', hl: "the sales director's approval is attached to the deal under Approvals", after: '.' },
};
const DEFAULT_SUGGESTIONS = ['Can I offer 20% off an annual plan?', 'When does the wifi password change?', 'What is the parking policy?', 'How do I roll back a release?'];

/* ---------- helpers ---------- */
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const svg = (d, size = 12, w = 2.2) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON_DOC = svg('<path d="M6 3h8l4 4v14H6z"/>');
const ICON_CHECK = svg('<path d="M5 12l5 5 9-10"/>', 12, 3);
const ICON_X = svg('<path d="M6 6l12 12M18 6L6 18"/>', 11, 2.4);
const ICON_ARROW = svg('<path d="M5 12h14M13 6l6 6-6 6"/>', 12, 2.4);
const ftype = (file) => (/\.docx$/i.test(file) ? 'docx' : 'pdf');
const words = (s) => new Set((s.toLowerCase().match(/[a-z0-9]{4,}/g) || []));
const relDate = (iso) => {
  const d = new Date(iso); if (isNaN(d)) return '';
  const days = Math.round((Date.now() - d) / 864e5);
  return days < 1 ? 'today' : days < 2 ? 'yesterday' : days < 30 ? `${days} days ago` : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

export async function initChat(life: Life, reduce: boolean) {
  const RAG = { reduce };
  const thread = $('thread'), chips = $('chips'), input = $('input'), send = $('send'), tray = $('tray');
  const drawer = $('drawer'), picker = $('picker'), grid = $('picker-grid'), scopeBtn = $('scope-btn');
  const docs = DEMO_DOCS;
  let busy = false;
  const selected = new Set();
  const byFile = (f) => docs.find((d) => d.file === f);

  /* ----- scope button, tray, suggestions ----- */
  const renderScope = () => {
    const picked = [...selected].map(byFile).filter(Boolean);
    $('scope-label').textContent = !picked.length ? 'All documents' : picked.length === 1 ? picked[0].title : `${picked.length} documents`;
    const stack = $('scope-stack'); stack.innerHTML = '';
    (picked.length ? picked.slice(0, 3) : [{ file: '' }]).forEach((d) => {
      const i = el('i', d.file ? `ft-${ftype(d.file)}` : 'ft-all', d.file ? ftype(d.file).toUpperCase().slice(0, 1) : '');
      stack.appendChild(i);
    });
    scopeBtn.setAttribute('aria-label', `Documents searched: ${$('scope-label').textContent}. Change`);

    // tray: one removable chip per picked document
    const keep = new Set(selected);
    [...tray.querySelectorAll('.tchip')].forEach((c) => {
      if (keep.has(c.dataset.file)) { keep.delete(c.dataset.file); return; }
      c.classList.add('leaving'); life.timeout(() => c.remove(), RAG.reduce ? 0 : 130);
    });
    if (selected.size && !tray.querySelector('.tlabel')) tray.prepend(el('span', 'tlabel', 'Searching'));
    if (!selected.size) tray.querySelector('.tlabel')?.remove();
    keep.forEach((f) => {
      const d = byFile(f); if (!d) return;
      const c = el('span', 'tchip'); c.dataset.file = f;
      c.innerHTML = `<i class="ft-${ftype(f)}"></i>`;
      c.append(d.title);
      const x = el('button'); x.type = 'button'; x.innerHTML = ICON_X; x.setAttribute('aria-label', `Stop searching ${d.title}`);
      x.onclick = () => { selected.delete(f); syncCards(); renderScope(); };
      c.appendChild(x); tray.appendChild(c);
    });
    renderSuggestions();
  };

  const renderSuggestions = () => {
    chips.innerHTML = '';
    let qs = DEFAULT_SUGGESTIONS;
    if (selected.size) {
      const lists = [...selected].map((f) => byFile(f)?.questions || []);
      qs = [];
      for (let i = 0; qs.length < 4 && lists.some((l) => l[i]); i++) lists.forEach((l) => { if (l[i] && qs.length < 4) qs.push(l[i]); });
    }
    qs.forEach((q) => { const b = el('button', 'chipq', q); b.type = 'button'; b.disabled = busy; b.onclick = () => ask(q); chips.appendChild(b); });
  };

  /* ----- picker ----- */
  const syncCards = () => {
    grid.querySelectorAll('.dcard').forEach((c) => {
      const on = selected.has(c.dataset.file);
      c.classList.toggle('is-on', on);
      c.querySelector('.dcard-hit').setAttribute('aria-pressed', on);
    });
    const n = selected.size;
    $('picker-count').textContent = n ? `${n} of ${docs.length} selected` : `${docs.length} documents`;
    $('picker-note').textContent = n ? `Questions will only search ${n === 1 ? 'this document' : `these ${n} documents`}.` : 'Nothing selected searches every document you can read.';
    $('picker-done').textContent = n ? `Search ${n} document${n === 1 ? '' : 's'}` : 'Search all documents';
  };

  const buildCards = () => {
    grid.innerHTML = '';
    docs.forEach((d, i) => {
      const card = el('article', 'dcard'); card.dataset.file = d.file; card.style.setProperty('--i', Math.min(i, 12));
      const hit = el('button', 'dcard-hit'); hit.type = 'button'; hit.setAttribute('aria-label', `${d.title}: ${d.summary}`);
      hit.onclick = () => { selected.has(d.file) ? selected.delete(d.file) : selected.add(d.file); syncCards(); renderScope(); };
      card.appendChild(hit);
      const top = el('div', 'dtop');
      const t = ftype(d.file); top.appendChild(el('span', `ftype ft-${t}`, t.toUpperCase()));
      const name = el('div'); name.appendChild(el('p', 'dname', d.title));
      name.appendChild(el('p', 'dmeta', [d.pages ? `${d.pages} page${d.pages === 1 ? '' : 's'}` : '', d.updated ? `updated ${d.updated}` : ''].filter(Boolean).join(' · ')));
      top.appendChild(name); card.appendChild(top);
      card.appendChild(el('p', 'dsum', d.summary));
      if (d.questions.length) {
        const qs = el('div', 'dqs'); qs.appendChild(el('span', 'dqs-label', 'It can answer'));
        d.questions.slice(0, 2).forEach((q) => {
          const b = el('button', 'dq'); b.type = 'button'; b.innerHTML = `<span></span>${ICON_ARROW}`; b.firstChild.textContent = q;
          b.setAttribute('aria-label', `Ask ${d.title}: ${q}`);
          b.onclick = () => { selected.add(d.file); syncCards(); renderScope(); closePicker(); ask(q); };
          qs.appendChild(b);
        });
        if (d.questions.length > 2) qs.appendChild(el('span', 'dmore', `+${d.questions.length - 2} more question${d.questions.length - 2 === 1 ? '' : 's'}`));
        card.appendChild(qs);
      }
      const check = el('span', 'dcheck'); check.innerHTML = ICON_CHECK; check.setAttribute('aria-hidden', 'true');
      card.appendChild(check);
      grid.appendChild(card);
    });
    syncCards();
  };

  const filterCards = () => {
    const q = $('picker-filter').value.trim().toLowerCase();
    let shown = 0;
    grid.querySelectorAll('.dcard').forEach((c) => {
      const d = byFile(c.dataset.file);
      const hit = !q || [d.title, d.summary, ...d.questions].join(' ').toLowerCase().includes(q);
      c.hidden = !hit; if (hit) shown++;
    });
    $('picker-empty').hidden = shown > 0;
  };
  const visibleFiles = () => [...grid.querySelectorAll('.dcard:not([hidden])')].map((c) => c.dataset.file);

  let closeT = 0;
  const openPicker = () => {
    clearTimeout(closeT);
    drawer.classList.remove('is-open'); drawer.setAttribute('aria-hidden', 'true');
    picker.hidden = false; void picker.offsetWidth;
    picker.classList.add('is-open'); scopeBtn.setAttribute('aria-expanded', 'true');
    if (matchMedia('(pointer: fine)').matches) $('picker-filter').focus({ preventScroll: true });
  };
  const closePicker = () => {
    picker.classList.remove('is-open'); scopeBtn.setAttribute('aria-expanded', 'false');
    closeT = life.timeout(() => { picker.hidden = true; }, RAG.reduce ? 0 : 150);
  };
  scopeBtn.onclick = () => (picker.classList.contains('is-open') ? closePicker() : openPicker());
  $('picker-done').onclick = () => { closePicker(); scopeBtn.focus({ preventScroll: true }); };
  picker.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePicker(); scopeBtn.focus({ preventScroll: true }); } });
  $('picker-filter').oninput = filterCards;
  $('pick-all').onclick = () => { visibleFiles().forEach((f) => selected.add(f)); syncCards(); renderScope(); };
  $('pick-none').onclick = () => { selected.clear(); syncCards(); renderScope(); };

  /* ----- source drawer ----- */
  const openSource = (src) => {
    const d = byFile(src.file) || { title: src.file, who: '' };
    $('src-doc').textContent = d.title;
    $('src-meta').textContent = [`p. ${src.page}`, d.who && `Readable by ${d.who}`].filter(Boolean).join(' · ');
    const p = $('src-text'); p.textContent = src.before || '';
    p.appendChild(el('span', 'hl', src.hl)); if (src.after) p.appendChild(document.createTextNode(src.after));
    drawer.classList.remove('is-open'); void drawer.offsetWidth;
    drawer.classList.add('is-open'); drawer.setAttribute('aria-hidden', 'false');
    $('close-drawer').focus({ preventScroll: true });
  };
  $('close-drawer').onclick = () => { drawer.classList.remove('is-open'); drawer.setAttribute('aria-hidden', 'true'); };

  /* ----- answering ----- */
  const scrollDown = () => thread.scrollTo({ top: thread.scrollHeight, behavior: RAG.reduce ? 'auto' : 'smooth' });
  const setBusy = (b) => { busy = b; chips.querySelectorAll('button').forEach((c) => (c.disabled = b)); send.disabled = b || !input.value.trim(); };

  // Demo stand-in for /api/chat: same contract (answer, citation, scoped_to).
  const demoAnswer = (q, scope) => {
    const inScope = (f) => !scope.length || scope.includes(f);
    const known = DEMO_QA[q];
    if (known && inScope(known.file)) return { answer: known.a, cite: { file: known.file, page: known.page, before: known.before, hl: known.hl, after: known.after } };
    if (/park/i.test(q)) return scope.length ? { answer: null } : { answer: 'None of your documents answer this yet. It has been sent to Knowledge gaps so someone can write it up.', gap: true };
    if (/roll ?back|deploy|release/i.test(q)) return scope.length ? { answer: null } : { answer: "I couldn't find this in the documents you can access." };
    const qw = words(q);
    let best = null, bestScore = 0;
    docs.filter((d) => inScope(d.file)).forEach((d) => {
      const s = [...words([d.title, d.summary, ...d.questions].join(' '))].filter((w) => qw.has(w)).length;
      if (s > bestScore) { best = d; bestScore = s; }
    });
    if (!best) return scope.length ? { answer: null } : { answer: 'None of your documents answer this yet. It has been sent to Knowledge gaps so someone can write it up.', gap: true };
    return { answer: `From the ${best.title}: ${best.summary}`, cite: { file: best.file, page: 1, hl: best.summary } };
  };

  function typeOut(r, text, done) {
    if (RAG.reduce) { r.textContent = text; return done(); }
    r.className = 'r'; r.textContent = ''; const caret = el('span', 'caret'); r.appendChild(caret);
    let n = 0; const txt = document.createTextNode(''); r.insertBefore(txt, caret);
    const iv = life.interval(() => { n = Math.min(text.length, n + 3); txt.data = text.slice(0, n); if (n % 30 < 3) scrollDown(); if (n >= text.length) { clearInterval(iv); r.textContent = text; done(); } }, 18);
  }

  async function ask(q, { instant = false, scope = [...selected] } = {}) {
    if (busy || !q) return;
    const um = el('div', 'msg is-user'); um.appendChild(el('div', 'u', q));
    if (scope.length) {
      const names = scope.map((f) => byFile(f)?.title || f);
      um.appendChild(el('span', 'scope-note', `in ${names.length > 2 ? `${names.length} documents` : names.join(' and ')}`));
    }
    thread.appendChild(um); input.value = ''; setBusy(true); scrollDown();

    const m = el('div', 'msg'); const r = el('div', instant || RAG.reduce ? 'r' : 'r thinking');
    if (!instant && !RAG.reduce) r.innerHTML = '<i></i><i></i><i></i>';
    m.appendChild(r); thread.appendChild(m); scrollDown();

    let res;
    const wait = instant ? 0 : 650;
    try {
      [res] = await Promise.all([Promise.resolve(demoAnswer(q, scope)), new Promise((ok) => life.timeout(ok, wait))]);
    } catch (e) {
      res = { answer: `Something went wrong: ${e.message}` };
    }

    const finish = () => {
      if (res.cite) {
        const d = byFile(res.cite.file);
        const b = el('button', 'cite-btn'); b.type = 'button'; b.innerHTML = ICON_DOC;
        b.append(`${d ? d.title : res.cite.file}, p. ${res.cite.page}`); b.onclick = () => openSource(res.cite); m.appendChild(b);
      }
      if (res.gap) m.appendChild(el('span', 'gap-tag', 'Added to Knowledge gaps'));
      if (res.answer === null) {
        const again = el('button', 'cite-btn', 'Search all documents instead'); again.type = 'button';
        again.onclick = () => ask(q, { scope: [] }); m.appendChild(again);
      }
      setBusy(false); scrollDown();
    };
    const text = res.answer === null
      ? `The ${scope.length === 1 ? 'selected document doesn’t' : `${scope.length} selected documents don’t`} answer this.`
      : res.answer;
    if (instant) { r.textContent = text; finish(); } else typeOut(r, text, finish);
  }

  input.oninput = () => (send.disabled = busy || !input.value.trim());
  $('composer').onsubmit = (e) => { e.preventDefault(); const t = input.value.trim(); if (t && !busy) ask(t); };
  $('new-chat').onclick = () => { thread.innerHTML = ''; drawer.classList.remove('is-open'); setBusy(false); };
  document.querySelectorAll('.recent').forEach((b) => (b.onclick = () => document.querySelectorAll('.recent').forEach((x) => x.classList.toggle('is-on', x === b))));

  buildCards();
  renderScope();
  ask('Can I offer 20% off an annual plan?', { instant: true, scope: [] });
}
