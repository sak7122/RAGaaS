// @ts-nocheck — the homepage journey scene, moved 1:1 from the approved canvas design
// (Home.dc.html). 96 document cards on a 2D canvas with a small perspective camera;
// scroll progress through `section` drives eleven chapters. The page owns the text;
// this module only draws and reports which chapter is showing.
import { COMPANIES } from "./companies";

/* ---------- the journey: chapters on one scroll ---------- */
const BEATS = [0, 0.07, 0.15, 0.24, 0.33, 0.42, 0.51, 0.60, 0.69, 0.78, 0.88];
const N = 96, COLS = 12, ROWS = 8, CW = 1.5, CH = 2.0, GX = 2.15, GY = 2.7;
const MATCH = [41, 54];                 // cards a question lights up
const LOCKED = [10, 11, 22, 23];        // a restricted block, top right
const GAPS = [19, 63, 75];              // holes in the wall: questions nothing answers
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const enter = (i, p) => smooth(BEATS[i] - 0.015, BEATS[i] + 0.035, p);     // 0 → 1 as chapter i begins
function rng(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }
const titleOf = (co, file) => (co.documents.find((d) => d.file === file) || { title: file }).title;

function buildCards() {
  const r = rng(29);
  const cards = [];
  for (let i = 0; i < N; i++) {
    const u = r() * 2 - 1, th = r() * Math.PI * 2, rad = 10 + r() * 7;
    const c = i % COLS, rw = Math.floor(i / COLS);
    cards.push({
      i, seed: r(), spin: r() * Math.PI * 2, spinV: (r() - 0.5) * 0.4, tilt: (r() - 0.5) * 0.9,
      cloud: [Math.sqrt(1 - u * u) * Math.cos(th) * rad * 1.35, u * rad * 0.8, Math.sqrt(1 - u * u) * Math.sin(th) * rad],
      grid: [(c - (COLS - 1) / 2) * GX, ((ROWS - 1) / 2 - rw) * GY, 0],
      lines: [0.9, 0.7 + r() * 0.25, 0.55 + r() * 0.35, 0.6 + r() * 0.3],
      match: MATCH.indexOf(i), locked: LOCKED.includes(i), gap: GAPS.indexOf(i)
    });
  }
  // 18 cards become the learning path, then the certificate ring
  const onPath = cards.filter((c, k) => (k % 5 === 0 || c.match >= 0) && !c.locked && c.gap < 0).slice(0, 18);
  onPath.forEach((c, k) => {
    const t = k / (onPath.length - 1);
    c.pathIndex = k;
    c.path = [Math.sin(t * Math.PI * 2.2) * 7, -4 + Math.cos(t * Math.PI * 1.1) * 2.2, 6 - t * 50];
    const a = (k / onPath.length) * Math.PI * 2 - Math.PI / 2;
    c.ring = [Math.cos(a) * 7.2, Math.sin(a) * 7.2, 0];
    c.ringAngle = a;
  });
  return { cards, pathLen: onPath.length };
}

// camera keyframe per chapter: [position, look-at]; chapter 0 orbits
const KEYS = [
  null,
  [[0, 0, 27], [0, 0, 0]],
  [[13, 4, 21], [6, 3, -1]],
  [[3, 1, 19], [0, 0, 0]],
  [[0, 0.4, 20], [0, 0.4, 14]],
  [[0, 0, 26], [0, 0, 0]],
  [[-4, 2, 18], [-5, 3, 0]],
  [[0, 2, 12], [0, -3, -10]],
  [[2, 1, -14], [0, -3, -36]],
  [[0, 0, 19], [0, 0, 0]],
  [[0, 7, 33], [0, 0, 0]]
];

export type SceneOptions = {
  canvas: HTMLCanvasElement;
  section: HTMLElement;
  getCompany: () => number;
  onStep: (step: number) => void;
  onHint: (show: boolean) => void;
  reduce: boolean;
};

class JourneyScene {
  constructor(o) {
    Object.assign(this, o);
    this.ctx = o.canvas.getContext("2d");
    this.loop = this.loop.bind(this);
    this.onResize = this.onResize.bind(this);
    this.onPointer = this.onPointer.bind(this);
    this.step = -1; this.hint = null;
  }

  start() {
    if (!this.ctx) return false;
    const built = buildCards();
    this.cards = built.cards; this.pathLen = built.pathLen;
    this.p = 0; this.t = 0; this.last = 0; this.ptr = [0, 0]; this.ptrS = [0, 0]; this.ripple = -10;
    this.onResize();
    window.addEventListener("resize", this.onResize);
    window.addEventListener("pointermove", this.onPointer, { passive: true });
    this.visible = true;
    this.vio = new IntersectionObserver(([e]) => {
      this.visible = e.isIntersecting;
      if (this.visible && !this.raf) { this.last = 0; this.raf = requestAnimationFrame(this.loop); }
    });
    this.vio.observe(this.section);
    this.raf = requestAnimationFrame(this.loop);
    return true;
  }

  dispose() {
    cancelAnimationFrame(this.raf); this.raf = 0; this.visible = false;
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("pointermove", this.onPointer);
    this.vio?.disconnect();
  }

  /** The wall ripples when the company changes. */
  rippleNow() { this.ripple = this.t; }

  onResize() {
    const dpr = Math.min(window.devicePixelRatio || 1, window.innerWidth < 760 ? 1.5 : 2);
    const r = this.canvas.getBoundingClientRect();
    this.W = r.width; this.H = r.height;
    this.canvas.width = Math.round(r.width * dpr); this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  onPointer(e) {
    if (this.reduce || e.pointerType === "touch") return;
    this.ptr = [(e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1];
  }

  loop(now) {
    this.raf = 0;
    if (!this.visible) return;
    const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 0.016;
    this.last = now;
    const r = this.section.getBoundingClientRect();
    const span = r.height - window.innerHeight;
    const pv = span > 0 ? Math.max(0, Math.min(1, -r.top / span)) : 0;
    this.p += (pv - this.p) * (this.reduce ? 1 : 1 - Math.exp(-4 * dt));
    const kp = 1 - Math.exp(-3 * dt);
    this.ptrS[0] += (this.ptr[0] - this.ptrS[0]) * kp; this.ptrS[1] += (this.ptr[1] - this.ptrS[1]) * kp;
    if (!this.reduce) this.t += dt;
    this.draw();
    const step = BEATS.filter((b) => pv >= b).length - 1;
    if (step !== this.step) { this.step = step; this.onStep(step); }
    const hint = pv <= 0.01;
    if (hint !== this.hint) { this.hint = hint; this.onHint(hint); }
    this.raf = requestAnimationFrame(this.loop);
  }

  draw() {
    const { ctx, W, H, cards } = this, p = this.p, t = this.t;
    const co = COMPANIES[this.getCompany()];
    const e = BEATS.map((_, i) => (i === 0 ? 1 : enter(i, p)));
    const aGrid = e[1];
    const aLock = e[2] * (1 - e[7]);
    const aAsk = e[3] * (1 - e[5]);
    const aOpen = e[4] * (1 - e[5]);
    const aGap = e[5] * (1 - e[7]);
    const aFill = e[6];
    const aPath = e[7] * (1 - e[9]);
    const aReview = e[8] * (1 - e[9]);
    const aRing = e[9] * (1 - e[10]);
    const aBack = e[10];

    // camera: orbit the cloud, then chain through each chapter's keyframe
    const orbit = this.reduce ? 0.3 : t * 0.12 + 0.3;
    let cam = [Math.sin(orbit) * 34, 2, Math.cos(orbit) * 34], look = [0, 0, 0];
    for (let i = 1; i < KEYS.length; i++) { cam = lerp3(cam, KEYS[i][0], e[i]); look = lerp3(look, KEYS[i][1], e[i]); }
    if (aPath > 0) {                                  // glide down the path through chapters 7-8
      const glide = smooth(BEATS[7], BEATS[9] - 0.01, p);
      cam[2] -= 6 * glide * (1 - e[9]);
    }
    const sway = 1.3;
    cam[0] += this.ptrS[0] * sway; cam[1] -= this.ptrS[1] * sway * 0.6;

    let f = [look[0] - cam[0], look[1] - cam[1], look[2] - cam[2]];
    const fl = Math.hypot(f[0], f[1], f[2]); f = f.map((v) => v / fl);
    let rt = [-f[2], 0, f[0]]; const rl = Math.hypot(rt[0], rt[2]) || 1; rt = [rt[0] / rl, 0, rt[2] / rl];
    const up = [rt[1] * f[2] - rt[2] * f[1], rt[2] * f[0] - rt[0] * f[2], rt[0] * f[1] - rt[1] * f[0]];
    const F = (H / 2) / Math.tan((50 * Math.PI / 180) / 2);
    const proj = (x, y, z) => {
      const dx = x - cam[0], dy = y - cam[1], dz = z - cam[2];
      const zc = dx * f[0] + dy * f[1] + dz * f[2];
      if (zc < 0.3) return null;
      return [W / 2 + (dx * rt[0] + dy * rt[1] + dz * rt[2]) * F / zc, H / 2 - (dx * up[0] + dy * up[1] + dz * up[2]) * F / zc, zc];
    };
    const projOn = (pos, rot, tilt, x, y) => {
      const cr = Math.cos(rot), sr = Math.sin(rot), ct = Math.cos(tilt), st = Math.sin(tilt);
      const x1 = x * cr, z1 = x * sr, y2 = y * ct - z1 * st, z2 = y * st + z1 * ct;
      return proj(pos[0] + x1, pos[1] + y2, pos[2] + z2);
    };
    const quad = (pos, rot, tilt, w, h) => [[-w, -h], [w, -h], [w, h], [-w, h]].map(([x, y]) => projOn(pos, rot, tilt, x, y));
    const path = (q) => { ctx.beginPath(); q.forEach((v, k) => (k ? ctx.lineTo(v[0], v[1]) : ctx.moveTo(v[0], v[1]))); ctx.closePath(); };
    const label = (text, x, y, bg, fg) => {
      ctx.font = "600 13px -apple-system, BlinkMacSystemFont, sans-serif"; ctx.textAlign = "center";
      const w = ctx.measureText(text).width + 22;
      ctx.fillStyle = bg; ctx.beginPath(); ctx.roundRect(x - w / 2, y - 24, w, 26, 13); ctx.fill();
      ctx.fillStyle = fg; ctx.fillText(text, x, y - 7);
    };

    ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#ffffff";
    for (let s = 0; s < 120; s++) {
      const sx = ((s * 97.13) % 1) * W, sy = ((s * 57.71) % 1) * H;
      ctx.globalAlpha = 0.08 + ((s * 13) % 7) / 40;
      ctx.fillRect((sx + this.ptrS[0] * -6 + W) % W, (sy + this.ptrS[1] * -4 + H) % H, 1.2, 1.2);
    }

    const rippleAge = t - this.ripple;
    const placed = [];
    cards.forEach((c) => {
      const drift = this.reduce ? 0 : Math.sin(t * 0.6 + c.seed * 9) * 0.35 * (1 - aGrid);
      let pos = lerp3([c.cloud[0], c.cloud[1] + drift, c.cloud[2]], c.grid, aGrid);
      let alpha = 1, glow = 0, warn = 0, rot = (c.spin + c.spinV * t) * (1 - aGrid), tilt = c.tilt * (1 - aGrid), scale = 1;
      if (rippleAge < 1.2 && aGrid > 0.5) {           // company switch: a wave across the wall
        const d = Math.hypot(c.grid[0], c.grid[1]) / 16;
        const k = Math.max(0, 1 - Math.abs(rippleAge * 1.6 - d) * 3);
        pos = [pos[0], pos[1], pos[2] + k * 1.2];
      }
      if (c.locked) { pos = [pos[0], pos[1], pos[2] - 2.5 * aLock]; alpha *= 1 - 0.45 * aLock; warn = aLock; }
      if (c.match >= 0) { pos = [pos[0], pos[1], pos[2] + 2.6 * aAsk]; glow = aAsk; }
      else alpha *= 1 - 0.6 * aAsk;
      if (c.match === 0 && aOpen > 0) {                // the cited card opens in front of the camera
        pos = lerp3(pos, [0, 0.4, 15.6], aOpen); rot *= 1 - aOpen; tilt *= 1 - aOpen; scale = 1 + 0.25 * aOpen;
      }
      if (c.gap >= 0) {
        const out = smooth(BEATS[5] - 0.03, BEATS[5] + 0.01, p) * (1 - aBack);
        const refill = c.gap === 0 ? aFill : 0;
        alpha *= 1 - out * (1 - refill);
        if (c.gap === 0 && refill > 0) { glow = Math.max(glow, refill * (1 - e[7])); pos = [pos[0], pos[1] + (1 - refill) * 9, pos[2] + (1 - refill) * 6]; }
      }
      const fade = Math.max(e[7] * (1 - aBack), 0);
      if (c.path) {
        pos = lerp3(pos, c.path, aPath > 0 ? e[7] : 0);
        if (e[9] > 0) pos = lerp3(pos, c.ring, e[9]);
        if (aBack > 0) pos = lerp3(pos, c.grid, aBack);
        rot *= 1 - e[7]; tilt = lerp(tilt, -0.3, aPath);
        if (e[9] > 0) { tilt = lerp(tilt, 0, e[9]); rot = lerp(rot, 0, e[9]); }
        if (c.pathIndex === 9 && aReview > 0) warn = Math.max(warn, aReview * (this.reduce ? 1 : 0.6 + 0.4 * Math.sin(t * 4)));
      } else alpha *= 1 - fade;
      if (aBack > 0 && !c.locked && c.gap < 0) glow = Math.max(glow, aBack * 0.35 * (0.5 + 0.5 * Math.sin(t * 1.4 + c.seed * 12)));
      if (alpha < 0.02) return;
      placed.push({ c, pos, alpha, glow, warn, rot, tilt, scale });
    });
    placed.sort((a, b) => {
      const da = (a.pos[0] - cam[0]) ** 2 + (a.pos[1] - cam[1]) ** 2 + (a.pos[2] - cam[2]) ** 2;
      const db = (b.pos[0] - cam[0]) ** 2 + (b.pos[1] - cam[1]) ** 2 + (b.pos[2] - cam[2]) ** 2;
      return db - da;
    });

    // learning path ribbon + milestones (under the cards)
    if (aPath > 0.02) {
      const pc = cards.filter((c) => c.path).sort((a, b) => a.pathIndex - b.pathIndex);
      const pts = pc.map((c) => proj(c.path[0], c.path[1] - CH / 2 - 0.25, c.path[2])).filter(Boolean);
      ctx.globalAlpha = aPath * 0.8; ctx.strokeStyle = "#2997ff"; ctx.lineWidth = 2; ctx.setLineDash([2, 7]);
      ctx.beginPath(); pts.forEach((v, k) => (k ? ctx.lineTo(v[0], v[1]) : ctx.moveTo(v[0], v[1]))); ctx.stroke(); ctx.setLineDash([]);
      const progress = smooth(BEATS[7] + 0.03, BEATS[9] - 0.02, p);
      pc.forEach((c) => {
        const v = proj(c.path[0], c.path[1] - CH / 2 - 0.25, c.path[2]); if (!v) return;
        const done = c.pathIndex / (this.pathLen - 1) < progress;
        const review = c.pathIndex === 9 && aReview > 0.1;
        const rad = Math.max(3, 0.32 * F / v[2]);
        ctx.globalAlpha = aPath;
        ctx.fillStyle = review ? "#ff9f0a" : done ? "#2997ff" : "#000"; ctx.strokeStyle = review ? "#ff9f0a" : "#2997ff"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(v[0], v[1], rad, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        const li = [2, 7, 12, 16].indexOf(c.pathIndex);
        if (li >= 0 && v[2] < 40) {
          const lesson = co.academy.lessons[li];
          ctx.globalAlpha = aPath * Math.max(0, 1 - v[2] / 40);
          label((li + 1) + "  " + lesson.title, v[0], v[1] - rad - 4, "rgba(29,29,31,.9)", "#f5f5f7");
        }
      });
      // the review loop: a missed lesson comes back
      if (aReview > 0.05) {
        const a = pc[9], b = pc[13];
        const va = proj(a.path[0], a.path[1] - CH / 2 - 0.25, a.path[2]), vb = proj(b.path[0], b.path[1] - CH / 2 - 0.25, b.path[2]);
        if (va && vb) {
          ctx.globalAlpha = aReview; ctx.strokeStyle = "#ff9f0a"; ctx.lineWidth = 2; ctx.setLineDash([5, 5]);
          const mx = (va[0] + vb[0]) / 2, my = Math.min(va[1], vb[1]) - 80;
          ctx.beginPath(); ctx.moveTo(vb[0], vb[1]); ctx.quadraticCurveTo(mx, my, va[0], va[1]); ctx.stroke(); ctx.setLineDash([]);
          label("Comes back in 3 days", mx, my + 20, "rgba(255,159,10,.95)", "#000");
        }
      }
    }

    // cards
    placed.forEach(({ c, pos, alpha, glow, warn, rot, tilt, scale }) => {
      const q = quad(pos, rot, tilt, (CW / 2) * scale, (CH / 2) * scale);
      if (q.some((v) => !v)) return;
      const depth = q[0][2];
      const fog = Math.max(0, Math.min(1, 1.25 - depth / 62));
      const a = alpha * fog;
      const nx = (q[1][0] - q[0][0]) * (q[3][1] - q[0][1]) - (q[1][1] - q[0][1]) * (q[3][0] - q[0][0]);
      ctx.globalAlpha = a;
      ctx.fillStyle = nx > 0 ? (c.locked && aLock > 0.3 ? "#3a3a3c" : "#f5f5f7") : "#3a3a3c";
      if (glow > 0.01) { ctx.shadowColor = "rgba(41,151,255,.9)"; ctx.shadowBlur = 26 * glow; }
      path(q); ctx.fill(); ctx.shadowBlur = 0;
      if (glow > 0.01) { ctx.globalAlpha = a * glow; ctx.strokeStyle = "#2997ff"; ctx.lineWidth = 2; ctx.stroke(); }
      if (warn > 0.01) { ctx.globalAlpha = a * warn; ctx.strokeStyle = "#ff9f0a"; ctx.lineWidth = 2; ctx.stroke(); }
      const size = Math.hypot(q[2][0] - q[0][0], q[2][1] - q[0][1]);
      if (size > 18 && nx > 0) {
        const open = c.match === 0 ? aOpen : 0;
        const nLines = open > 0.5 ? 9 : 4;
        ctx.lineCap = "round";
        for (let k = 0; k < nLines; k++) {
          const w = k < 4 ? c.lines[k] : 0.55 + ((k * 37) % 40) / 100;
          const yy = (-CH / 2 + 0.36 + k * (open > 0.5 ? 0.19 : 0.36)) * scale;
          const x0 = (-CW / 2 + 0.2) * scale, x1 = x0 + (CW - 0.4) * scale * w;
          const pa = projOn(pos, rot, tilt, x0, yy), pb = projOn(pos, rot, tilt, x1, yy);
          if (!pa || !pb) continue;
          const cited = open > 0.5 && k === 4;
          if (cited) {                                   // the cited line, swept with a highlight
            const sweep = smooth(BEATS[4] + 0.01, BEATS[4] + 0.05, p);
            const ph = projOn(pos, rot, tilt, x0 + (x1 - x0) * sweep, yy);
            ctx.globalAlpha = a * 0.5; ctx.strokeStyle = "#2997ff"; ctx.lineWidth = Math.max(4, 0.16 * F / depth);
            ctx.beginPath(); ctx.moveTo(pa[0], pa[1]); ctx.lineTo(ph[0], ph[1]); ctx.stroke();
          }
          ctx.globalAlpha = a * 0.8;
          ctx.strokeStyle = k === 0 ? "#1d1d1f" : (c.locked && aLock > 0.3 ? "#48484a" : "#a1a1a6");
          ctx.lineWidth = Math.max(1, (k === 0 ? 0.11 : 0.06) * F / depth);
          ctx.beginPath(); ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]); ctx.stroke();
        }
      }
    });

    // restricted block: a fence and its label
    if (aLock > 0.02) {
      const g0 = cards[LOCKED[0]].grid, g3 = cards[LOCKED[3]].grid;
      const x0 = g0[0] - CW / 2 - 0.35, x1 = g3[0] + CW / 2 + 0.35, y0 = g3[1] - CH / 2 - 0.35, y1 = g0[1] + CH / 2 + 0.35, z = -2.5 * aLock;
      const q = [proj(x0, y0, z), proj(x1, y0, z), proj(x1, y1, z), proj(x0, y1, z)];
      if (q.every(Boolean)) {
        ctx.globalAlpha = aLock; ctx.strokeStyle = "#ff9f0a"; ctx.lineWidth = 2; ctx.setLineDash([7, 6]); path(q); ctx.stroke(); ctx.setLineDash([]);
        const r = co.documents.find((d) => d.restricted);
        if (r) label("Restricted · " + r.audience, (q[2][0] + q[3][0]) / 2, q[3][1] - 6, "rgba(255,159,10,.95)", "#000");
      }
    }

    // gap slots
    if (aGap > 0.02) {
      GAPS.forEach((gi, k) => {
        const g = cards[gi].grid;
        const filled = k === 0 ? aFill : 0;
        const q = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => proj(g[0] + x * CW / 2, g[1] + y * CH / 2, g[2]));
        if (q.some((v) => !v)) return;
        const beat = this.reduce ? 0.5 : (Math.sin(t * 3 + k) + 1) / 2;
        ctx.globalAlpha = aGap * (1 - filled) * (0.55 + 0.45 * beat); ctx.strokeStyle = "#ff9f0a"; ctx.lineWidth = 2; ctx.setLineDash([6, 5]);
        path(q); ctx.stroke(); ctx.setLineDash([]);
        ctx.globalAlpha = aGap * (1 - filled) * 0.12; ctx.fillStyle = "#ff9f0a"; ctx.fill();
        const cx = (q[0][0] + q[2][0]) / 2, cy = (q[0][1] + q[2][1]) / 2;
        ctx.globalAlpha = aGap * (1 - filled); ctx.fillStyle = "#ff9f0a";
        ctx.font = "600 " + Math.round(Math.max(14, 0.9 * F / q[0][2])) + "px -apple-system, BlinkMacSystemFont, sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("?", cx, cy); ctx.textBaseline = "alphabetic";
        if (k === 0 && filled > 0.6) {
          ctx.globalAlpha = aGap * filled;
          label("New · " + co.new_doc.title, cx, q[0][1] - 8, "rgba(41,151,255,.95)", "#fff");
        }
      });
    }

    // the question streak and the two cited sources
    if (aAsk > 0.01) {
      const travel = smooth(BEATS[3], BEATS[3] + 0.05, p);
      const origin = [cam[0] - 2, cam[1] - 5, cam[2] - 3];
      const cites = [co.qa.doc + "|" + co.qa.page, co.qa.also_cites.doc + "|" + co.qa.also_cites.page];
      MATCH.forEach((mi, k) => {
        const g = cards[mi].grid, target = [g[0], g[1], g[2] + 2.6 * aAsk];
        const head = lerp3(origin, target, travel);
        const a = proj(origin[0], origin[1], origin[2]), b = proj(head[0], head[1], head[2]);
        if (!a || !b) return;
        ctx.globalCompositeOperation = "lighter";
        const grad = ctx.createLinearGradient(a[0], a[1], b[0], b[1]);
        grad.addColorStop(0, "rgba(41,151,255,0)"); grad.addColorStop(1, "rgba(41,151,255,.9)");
        ctx.globalAlpha = aAsk * (1 - aOpen); ctx.strokeStyle = grad; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        ctx.globalCompositeOperation = "source-over";
        if (travel > 0.95 && aOpen < 0.5) {
          const lp = proj(target[0], target[1] + CH / 2 + 0.5, target[2]);
          const [file, page] = cites[k].split("|");
          if (lp) { ctx.globalAlpha = aAsk * 0.95; label((k + 1) + "  " + titleOf(co, file) + " · p. " + page, lp[0], lp[1], "rgba(29,29,31,.92)", "#f5f5f7"); }
        }
      });
    }

    // the certificate: a seal in the middle of the ring
    if (aRing > 0.02) {
      const c0 = proj(0, 0, 0), c1 = proj(2.6, 0, 0);
      if (c0 && c1) {
        const rad = Math.abs(c1[0] - c0[0]);
        ctx.globalAlpha = aRing; ctx.strokeStyle = "#2997ff"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(c0[0], c0[1], rad, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(c0[0], c0[1], rad * 0.86, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = "#f5f5f7"; ctx.textAlign = "center";
        ctx.font = "600 " + Math.round(rad * 0.24) + "px -apple-system, BlinkMacSystemFont, sans-serif"; ctx.fillText("Certified", c0[0], c0[1] - rad * 0.05);
        ctx.fillStyle = "#a1a1a6"; ctx.font = "500 " + Math.round(rad * 0.13) + "px -apple-system, BlinkMacSystemFont, sans-serif";
        ctx.fillText(co.persona.name + " · " + co.academy.role, c0[0], c0[1] + rad * 0.22);
      }
    }
    ctx.globalAlpha = 1;
  }

}

export const CHAPTER_COUNT = BEATS.length;

export function createJourneyScene(o: SceneOptions): { dispose(): void; rippleNow(): void } | null {
  const scene = new JourneyScene(o);
  return scene.start() ? scene : null;
}
