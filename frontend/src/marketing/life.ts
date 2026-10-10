// Tracks everything a marketing page starts (listeners, timers, observers, frames)
// so leaving the page undoes all of it. The page DOM itself is owned by React.
export type Life = {
  on: <K extends keyof WindowEventMap>(
    target: Window | Document | HTMLElement, type: K | string,
    fn: (e: any) => void, opts?: AddEventListenerOptions) => void;
  timeout: (fn: () => void, ms: number) => number;
  interval: (fn: () => void, ms: number) => number;
  observe: (o: { disconnect(): void }) => void;
  add: (dispose: () => void) => void;
  dispose: () => void;
  alive: () => boolean;
};

export function createLife(): Life {
  const disposers: (() => void)[] = [];
  let alive = true;
  return {
    on(target, type, fn, opts) {
      target.addEventListener(type as string, fn, opts);
      disposers.push(() => target.removeEventListener(type as string, fn, opts));
    },
    timeout(fn, ms) {
      const id = window.setTimeout(() => { if (alive) fn(); }, ms);
      disposers.push(() => clearTimeout(id));
      return id;
    },
    interval(fn, ms) {
      const id = window.setInterval(() => { if (alive) fn(); }, ms);
      disposers.push(() => clearInterval(id));
      return id;
    },
    observe(o) { disposers.push(() => o.disconnect()); },
    add(dispose) { disposers.push(dispose); },
    dispose() {
      alive = false;
      while (disposers.length) {
        try { disposers.pop()!(); } catch { /* keep disposing */ }
      }
    },
    alive: () => alive,
  };
}

export const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
export const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
export const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
