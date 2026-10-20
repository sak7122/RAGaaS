// Small motion pieces shared by the Academy screens: count-up numbers, progress
// rings, initials avatars. Transform/opacity only; reduced motion shows final values.
import { useEffect, useRef, useState } from "react";
import { animate, motion, useInView, useReducedMotion } from "framer-motion";

export const EASE_OUT = [0.23, 1, 0.32, 1] as const;

export const rise = (i = 0, base = 0) => ({
  initial: { opacity: 0, transform: "translateY(10px)" },
  animate: { opacity: 1, transform: "translateY(0px)", transition: { duration: 0.4, ease: EASE_OUT, delay: base + i * 0.05 } },
});

/** A number that counts up from 0 the first time it scrolls into view. */
export function CountUp({ value, format = (n) => String(Math.round(n)), duration = 0.9 }: {
  value: number; format?: (n: number) => string; duration?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true });
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(reduce ? value : 0);
  useEffect(() => {
    if (reduce) { setShown(value); return; }
    if (!inView) return;
    const c = animate(0, value, { duration, ease: EASE_OUT, onUpdate: setShown });
    return () => c.stop();
  }, [value, inView, reduce, duration]);
  return <span ref={ref} className="num">{format(shown)}</span>;
}

/** Circular progress, 0..1. The arc draws in once; the label sits in the middle. */
export function Ring({ value, size = 56, stroke = 5, tone = "blue", children, label }: {
  value: number; size?: number; stroke?: number; tone?: "blue" | "green" | "orange";
  children?: React.ReactNode; label?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <span className={`acx-ring is-${tone}`} style={{ width: size, height: size }} role={label ? "img" : undefined} aria-label={label}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="acx-ring-track" />
        <motion.circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} strokeLinecap="round"
          className="acx-ring-arc" strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - v), transition: { duration: 1, ease: EASE_OUT, delay: 0.15 } }}
          transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      {children && <span className="acx-ring-in">{children}</span>}
    </span>
  );
}

const AV_COLORS = ["#0a84ff", "#30a46c", "#bf5af2", "#ff9f0a", "#ff375f", "#5e5ce6", "#0a9396", "#d9480f"];

export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  const parts = name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  const ini = (parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] ?? "?").slice(0, 2)).toUpperCase();
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span className="acx-av" style={{ width: size, height: size, background: AV_COLORS[h % AV_COLORS.length], fontSize: size * 0.38 }} aria-hidden="true">
      {ini}
    </span>
  );
}

/** Thin bar that grows from the left once. */
export function Bar({ value, tone = "blue", delay = 0 }: { value: number; tone?: "blue" | "green" | "orange" | "red"; delay?: number }) {
  return (
    <span className={`acx-bar is-${tone}`}>
      <motion.b initial={{ transform: "scaleX(0)" }}
        animate={{ transform: `scaleX(${Math.max(0, Math.min(1, value))})`, transition: { duration: 0.8, ease: EASE_OUT, delay } }} />
    </span>
  );
}
