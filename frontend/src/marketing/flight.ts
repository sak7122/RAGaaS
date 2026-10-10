// @ts-nocheck — ported from design/proto/assets/doc-flight.js (three.js scene).
// "Question flight": the Ask page hero. A night-time field of documents laid out like a circuit board.
// Scrolling through the pinned section moves through four beats:
//   1 search  — blue traces carry the question from the front to the documents
//   2 access  — a gate round the restricted documents lights orange; their trace stops at it
//   3 rank    — other traces fade; the three best matches get labelled badges
//   4 answer  — the camera dives onto the top match, its cited line lights up
// The camera eases toward the scroll position (exponential follow), the loop only runs while the hero is
// on screen, and reduced motion freezes the pulses and drops the follow easing.
import * as THREE from 'three';

const SX = 3.4, SZ = 4.2, PW = 2.2, PD = 2.9;
const TEX_W = 512, TEX_H = Math.round(512 * PD / PW);
const SKIP = new Set(['-3,0', '3,0', '2,0', '-2,4', '3,4']);
const RESTRICTED = { '3,1': 'Payroll bands', '3,2': 'Board minutes', '3,3': 'Legal holds' };
export const MATCHES = {
  '-1,2': { rank: 1, doc: 'Sales playbook', page: 'p. 4' },
  '1,1': { rank: 2, doc: 'Pricing sheet', page: 'p. 2' },
  '-2,3': { rank: 3, doc: 'CRM guide', page: 'p. 7' },
};
const NAMES = ['Company handbook', 'Expense policy', 'Travel policy', 'Deploy runbook', 'Security basics', 'Brand guide',
  'Onboarding checklist', 'Holiday calendar', 'Benefits overview', 'IT setup', 'Incident playbook', 'Hiring guide',
  'Code of conduct', 'Office guide', 'Support macros', 'Release notes', 'Product FAQ', 'Data retention', 'Vendor list',
  'Partner terms', 'Refund policy', 'Remote work', 'Laptop policy', 'Meeting norms', 'Style guide', 'API overview', 'Q3 plan'];
const TRACE_TO = ['-1,2', '1,1', '-2,3', '0,1', '2,2', '-3,1', '1,3', '-1,0', '1,4'];
const SRC_Z = 6.2;
const TARGET = { x: -SX, z: -2 * SZ };
const GATE = { x0: 8.7, x1: 11.7, z0: -14.4, z1: -2.4 };
const CAM = [[3, 36, 32], [0, 22, 14], [TARGET.x + 4, 9, TARGET.z + 8], [TARGET.x, 4.4, TARGET.z + 2.6]];
// Lands looking a little left of the page, so it sits right of centre, clear of the captions.
const LOOK = [[0, 0, -7], [TARGET.x - 0.9, 0, TARGET.z - 0.15]];
export const BEATS = [0.13, 0.36, 0.57, 0.78];

const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const bez = (a, b, c, d, t) => { const u = 1 - t; return a.map((_, i) => u * u * u * a[i] + 3 * u * u * t * b[i] + 3 * u * t * t * c[i] + t * t * t * d[i]); };
function rng(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }

const HL_LINE = 3; // which body line on the top match is the cited one
function lineLayout(i) { return { y: 150 + i * 46, h: 14 }; }

function docTexture(title, opts, rand) {
  const c = document.createElement('canvas'); c.width = TEX_W; c.height = TEX_H;
  const g = c.getContext('2d');
  const dark = !!opts.restricted;
  g.fillStyle = dark ? '#2c2c2e' : '#f5f5f7'; g.fillRect(0, 0, TEX_W, TEX_H);
  g.fillStyle = dark ? '#8e8e93' : '#1d1d1f';
  g.font = '600 40px -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif';
  g.fillText(title, 36, 78);
  g.font = '400 22px -apple-system, BlinkMacSystemFont, sans-serif';
  g.fillStyle = dark ? '#636366' : '#86868b';
  g.fillText(dark ? 'Restricted clearance' : opts.meta || 'Everyone · v3', 36, 112);
  for (let i = 0; i < 10; i++) {
    const { y, h } = lineLayout(i);
    const w = (i % 4 === 3 ? 0.55 : 0.78) + rand() * 0.18;
    g.fillStyle = dark ? '#3a3a3c' : '#c7c7cc';
    g.beginPath(); g.roundRect(36, y, (TEX_W - 72) * Math.min(w, 0.98), h, 7); g.fill();
  }
  if (dark) {
    g.strokeStyle = '#636366'; g.lineWidth = 6;
    const lx = TEX_W / 2, ly = TEX_H - 130;
    g.strokeRect(lx - 34, ly, 68, 52); g.beginPath(); g.arc(lx, ly, 22, Math.PI, 0); g.stroke();
  } else {
    g.fillStyle = '#86868b'; g.font = '400 20px -apple-system, sans-serif';
    g.fillText(opts.page || 'p. 1', TEX_W - 90, TEX_H - 34);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

export function initFlight({ section, canvas, labels, onBeat, onProgress }) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' }); }
  catch { return null; }
  const lowPower = innerWidth < 760;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, lowPower ? 1.5 : 2));
  renderer.setClearColor(0x000000, 1);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x000000, 44, 100);
  const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 200);
  const rand = rng(11);

  // floor lanes
  const lanePts = [];
  for (let x = -5 * SX + 1.7; x <= 5 * SX; x += SX) lanePts.push(x, 0, 9, x, 0, -24);
  for (let z = 2.1; z >= -24; z -= SZ) lanePts.push(-18, 0, z, 18, 0, z);
  const laneGeo = new THREE.BufferGeometry(); laneGeo.setAttribute('position', new THREE.Float32BufferAttribute(lanePts, 3));
  scene.add(new THREE.LineSegments(laneGeo, new THREE.LineBasicMaterial({ color: 0x1c2233 })));

  // documents
  const pages = [];
  const planeGeo = new THREE.PlaneGeometry(PW, PD); planeGeo.rotateX(-Math.PI / 2);
  let n = 0;
  for (let r = 0; r < 5; r++) for (let c = -3; c <= 3; c++) {
    const k = `${c},${r}`; if (SKIP.has(k)) continue;
    const restricted = RESTRICTED[k];
    const match = MATCHES[k];
    const title = restricted || (match ? match.doc : NAMES[n++ % NAMES.length]);
    const x = c * SX, z = -r * SZ;
    const group = new THREE.Group(); group.position.set(x, 0, z);
    const stack = Math.floor(rand() * 3);
    for (let s = stack; s > 0; s--) {
      const under = new THREE.Mesh(planeGeo, new THREE.MeshBasicMaterial({ color: restricted ? 0x1f1f21 : 0xb8b8bd, transparent: true }));
      under.position.set(s * 0.13, -0.002 * s, s * 0.13); group.add(under);
    }
    const mat = new THREE.MeshBasicMaterial({ map: docTexture(title, { restricted: !!restricted, page: match ? match.page : `p. ${1 + Math.floor(rand() * 12)}`, meta: match ? 'Sales team · v3' : undefined }, rand), transparent: true });
    const top = new THREE.Mesh(planeGeo, mat); top.position.y = 0.01; group.add(top);
    scene.add(group);
    pages.push({ k, x, z, group, mats: group.children.map((m) => m.material), restricted: !!restricted, match });
  }

  // the cited line's highlight on the top match (scaled from its left edge)
  const { y: hy, h: hh } = lineLayout(HL_LINE);
  const hlW = PW * 0.86, hlD = (hh + 16) / TEX_H * PD;
  const hlGeo = new THREE.PlaneGeometry(hlW, hlD); hlGeo.rotateX(-Math.PI / 2); hlGeo.translate(hlW / 2, 0, 0);
  const hl = new THREE.Mesh(hlGeo, new THREE.MeshBasicMaterial({ color: 0x2997ff, transparent: true, opacity: 0.5, depthWrite: false }));
  hl.position.set(TARGET.x - PW / 2 + 36 / TEX_W * PW - 0.04, 0.02, TARGET.z - PD / 2 + (hy + hh / 2) / TEX_H * PD);
  hl.scale.x = 0.0001; hl.renderOrder = 10; scene.add(hl);

  // traces: flat glowing strips along Manhattan routes
  const route = (k) => {
    const [c, r] = k.split(',').map(Number);
    const lx = c * SX + (c >= 0 ? 1.7 : -1.7), lz = -r * SZ + 2.1;
    return [[0, SRC_Z], [0, 2.1], [lx, 2.1], [lx, lz], [c * SX, lz], [c * SX, -r * SZ + PD / 2]];
  };
  const traces = [];
  const mkTrace = (pts, meta) => {
    const segs = []; let L = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len > 0.001) { segs.push({ a, b, len, at: L }); L += len; }
    }
    const color = meta.blocked ? 0xff9f0a : 0x2997ff;
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    const w = meta.rank === 1 ? 0.09 : 0.06;
    segs.forEach((s) => {
      const geo = new THREE.PlaneGeometry(s.len + w, w); geo.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(geo, mat);
      m.position.set((s.a[0] + s.b[0]) / 2, 0.03, (s.a[1] + s.b[1]) / 2);
      m.rotation.y = -Math.atan2(s.b[1] - s.a[1], s.b[0] - s.a[0]);
      scene.add(m);
    });
    const dotMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    const dots = [];
    const per = lowPower ? 1 : 2;
    for (let j = 0; j < per * 6; j++) {
      const d = new THREE.Mesh(new THREE.CircleGeometry(0.17 * (1 - (j % 6) * 0.13), 16), dotMat.clone());
      d.rotation.x = -Math.PI / 2; scene.add(d); dots.push(d);
    }
    traces.push({ ...meta, segs, L, mat, dots, per, seed: rand() });
  };
  TRACE_TO.forEach((k) => mkTrace(route(k), { k, rank: (MATCHES[k] || {}).rank || 0 }));
  mkTrace([[0, SRC_Z], [0, 2.1], [10.2, 2.1], [10.2, GATE.z1 + 0.3]], { k: 'gate', rank: 0, blocked: true });
  const pointAt = (tr, s) => {
    for (const g of tr.segs) if (s <= g.at + g.len) { const f = (s - g.at) / g.len; return [g.a[0] + (g.b[0] - g.a[0]) * f, g.a[1] + (g.b[1] - g.a[1]) * f]; }
    const e = tr.segs[tr.segs.length - 1].b; return e;
  };

  // restricted gate
  const gp = [];
  const G = GATE;
  [[G.x0, G.z0, G.x1, G.z0], [G.x1, G.z0, G.x1, G.z1], [G.x1, G.z1, G.x0, G.z1], [G.x0, G.z1, G.x0, G.z0]].forEach(([a, b, c, d]) => gp.push(a, 0.04, b, c, 0.04, d));
  const gateGeo = new THREE.BufferGeometry(); gateGeo.setAttribute('position', new THREE.Float32BufferAttribute(gp, 3));
  const gateMat = new THREE.LineDashedMaterial({ color: 0x48484a, dashSize: 0.4, gapSize: 0.3, transparent: true });
  const gate = new THREE.LineSegments(gateGeo, gateMat); gate.computeLineDistances(); scene.add(gate);

  // question origin ring
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x2997ff, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.58, 48), ringMat); ring.rotation.x = -Math.PI / 2; ring.position.set(0, 0.04, SRC_Z); scene.add(ring);
  const ring2 = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.55, 48), ringMat.clone()); ring2.rotation.x = -Math.PI / 2; ring2.position.copy(ring.position); scene.add(ring2);

  // ---------- loop ----------
  let p = 0, pv = 0, t = 0, last = 0, raf = 0, visible = true, beat = -1;
  const ptr = [0, 0], ptrS = [0, 0];
  const v = new THREE.Vector3();
  const resize = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h;
    camera.fov = w / h < 0.8 ? 62 : 46; camera.updateProjectionMatrix();
  };
  const onPtr = (e) => { if (!reduce && e.pointerType !== 'touch') { ptr[0] = e.clientX / innerWidth * 2 - 1; ptr[1] = e.clientY / innerHeight * 2 - 1; } };
  addEventListener('resize', resize); addEventListener('pointermove', onPtr, { passive: true });
  resize();

  const place = (el, wx, wy, wz, alpha) => {
    v.set(wx, wy, wz).project(camera);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const behind = v.z > 1;
    el.style.opacity = behind ? 0 : alpha.toFixed(3);
    el.style.transform = `translate3d(${((v.x + 1) / 2 * w).toFixed(1)}px, ${((1 - v.y) / 2 * h).toFixed(1)}px, 0) translate(-50%, -100%)`;
  };

  const frame = (now) => {
    raf = 0; if (!visible) return;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016; last = now;
    const r = section.getBoundingClientRect();
    const span = r.height - innerHeight;
    pv = span > 0 ? Math.max(0, Math.min(1, -r.top / span)) : 0;
    p += (pv - p) * (reduce ? 1 : 1 - Math.exp(-5 * dt));
    const kp = 1 - Math.exp(-3 * dt);
    ptrS[0] += (ptr[0] - ptrS[0]) * kp; ptrS[1] += (ptr[1] - ptrS[1]) * kp;
    if (!reduce) t += dt;

    const ct = p < 0.5 ? p * 0.3 : 0.15 + 0.85 * smooth(0.5, 1, p);
    const cam = bez(CAM[0], CAM[1], CAM[2], CAM[3], ct);
    const lk = LOOK[0].map((val, i) => val + (LOOK[1][i] - val) * smooth(0.1, 1, ct));
    if (camera.aspect < 0.8) lk[0] += 0.9 * smooth(0.1, 1, ct); // phones: land centred, captions sit below
    const sway = (1 - ct) * 1.6;
    camera.position.set(cam[0] + ptrS[0] * sway + (reduce ? 0 : Math.sin(t * 0.25) * 0.6 * (1 - ct)), cam[1] - ptrS[1] * sway * 0.5, cam[2]);
    camera.lookAt(lk[0], lk[1], lk[2]);

    const aSearch = 0.4 + 0.6 * smooth(0.02, 0.2, p); // traces already pulse at rest
    const aGate = smooth(0.34, 0.42, p) * (1 - smooth(0.6, 0.7, p));
    const aRank = smooth(0.56, 0.66, p);
    const aLand = smooth(0.8, 0.95, p);

    pages.forEach((pg) => {
      let a = 1;
      if (pg.restricted) a = 0.7;
      else if (!pg.match) a = 1 - 0.7 * aRank;
      pg.mats.forEach((m) => { m.opacity = a; });
    });
    hl.scale.x = Math.max(0.0001, aLand);
    gateMat.color.set(aGate > 0.05 ? 0xff9f0a : 0x48484a);
    gateMat.opacity = 0.5 + 0.5 * aGate;

    traces.forEach((tr) => {
      let ta = 0.3 * aSearch;
      if (tr.rank) ta += 0.5 * aRank;
      else if (tr.blocked) ta += 0.35 * aGate;
      else ta *= 1 - 0.9 * aRank;
      tr.mat.opacity = ta;
      const pa = Math.min(1, ta * 2.4);
      const speed = tr.rank === 1 ? 7 : 5.5;
      for (let j = 0; j < tr.per; j++) {
        const head = reduce ? tr.L * (0.35 + 0.4 * j) : (t * speed + tr.seed * tr.L + j * tr.L / tr.per) % (tr.L + 3);
        for (let i = 0; i < 6; i++) {
          const d = tr.dots[j * 6 + i];
          const sPos = head - i * 0.22;
          if (head > tr.L || sPos < 0 || pa < 0.02) { d.visible = false; continue; }
          const pt = pointAt(tr, sPos);
          d.visible = true; d.position.set(pt[0], 0.05, pt[1]); d.material.opacity = pa * (1 - i / 6);
        }
      }
    });

    const beatT = reduce ? 0.5 : (t * 0.8) % 1;
    ring2.scale.setScalar(1 + beatT * 1.4); ring2.material.opacity = 0.6 * (1 - beatT) * (1 - smooth(0.5, 0.7, p));
    ringMat.opacity = 0.9 * (1 - smooth(0.6, 0.8, p));

    renderer.render(scene, camera);

    // HTML labels pinned to the scene
    if (labels) {
      place(labels.origin, 0, 0.05, SRC_Z + 0.9, 1 - smooth(0.3, 0.45, p));
      place(labels.gate, (G.x0 + G.x1) / 2, 0.05, G.z1, aGate);
      Object.entries(MATCHES).forEach(([k, m]) => {
        const [c, r] = k.split(',').map(Number);
        const el = labels.matches[m.rank - 1];
        const alpha = m.rank === 1 ? aRank : aRank * (1 - aLand);
        place(el, c * SX, 0.05, -r * SZ - PD / 2 - 0.15, alpha);
      });
      labels.matches[0].classList.toggle('is-diving', aLand > 0.05);
    }

    const b = BEATS.filter((s) => pv >= s).length;
    if (b !== beat) { beat = b; onBeat && onBeat(b); }
    onProgress && onProgress(pv);
    raf = requestAnimationFrame(frame);
  };

  const io = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible && !raf) { last = 0; raf = requestAnimationFrame(frame); }
  });
  io.observe(section);
  raf = requestAnimationFrame(frame);
  return {
    dispose() {
      cancelAnimationFrame(raf); visible = false; io.disconnect();
      removeEventListener('resize', resize); removeEventListener('pointermove', onPtr);
      scene.traverse((o) => { o.geometry?.dispose?.(); const mats = [].concat(o.material || []); mats.forEach((mm) => { mm.map?.dispose?.(); mm.dispose?.(); }); });
      renderer.dispose();
    },
  };
}
