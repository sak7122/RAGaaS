/**
 * Reusable animated UI primitives.
 * Drop-in components that add motion and polish without library overhead.
 */
import {
  ButtonHTMLAttributes,
  CSSProperties,
  MouseEvent,
  ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { motion, AnimatePresence } from "framer-motion";

// ── BlurIn ────────────────────────────────────────────────────────────────────
export function BlurIn({
  children,
  className,
  delay = 0,
  duration = 0.4,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  duration?: number;
}) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, filter: "blur(8px)", y: 8 }}
      animate={{ opacity: 1, filter: "blur(0px)", y: 0 }}
      transition={{ duration, delay, ease: [0.4, 0, 0.2, 1] }}
    >
      {children}
    </motion.div>
  );
}

// ── GradientText ──────────────────────────────────────────────────────────────
export function GradientText({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={`gradient-text ${className ?? ""}`}>{children}</span>;
}

// ── Aurora animated background blobs ─────────────────────────────────────────
export function Aurora({ className }: { className?: string }) {
  return (
    <div className={`aurora-bg ${className ?? ""}`} aria-hidden="true">
      <div className="aurora-orb aurora-orb-1" />
      <div className="aurora-orb aurora-orb-2" />
      <div className="aurora-orb aurora-orb-3" />
      <div className="aurora-noise" />
    </div>
  );
}

// ── ShinyButton ───────────────────────────────────────────────────────────────
export function ShinyButton({
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...props} className={`shiny-btn ${className ?? ""}`}>
      <span className="shiny-shine" aria-hidden="true" />
      <span className="shiny-content">{children}</span>
    </button>
  );
}

// ── SpotlightCard ─────────────────────────────────────────────────────────────
export function SpotlightCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: -999, y: -999 });

  function onMove(e: MouseEvent<HTMLDivElement>) {
    const r = ref.current!.getBoundingClientRect();
    setPos({ x: e.clientX - r.left, y: e.clientY - r.top });
  }

  return (
    <div
      ref={ref}
      className={`spotlight-card ${className ?? ""}`}
      onMouseMove={onMove}
      onMouseLeave={() => setPos({ x: -999, y: -999 })}
      style={
        {
          "--sx": `${pos.x}px`,
          "--sy": `${pos.y}px`,
        } as CSSProperties
      }
    >
      <div className="spotlight-glow" />
      {children}
    </div>
  );
}

// ── CountUp ───────────────────────────────────────────────────────────────────
export function CountUp({
  to,
  suffix = "",
  duration = 1000,
}: {
  to: number;
  suffix?: string;
  duration?: number;
}) {
  const [val, setVal] = useState(0);
  useEffect(() => {
    let start: number | null = null;
    const raf = (ts: number) => {
      if (!start) start = ts;
      const p = Math.min((ts - start) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      setVal(Math.round(eased * to));
      if (p < 1) requestAnimationFrame(raf);
    };
    requestAnimationFrame(raf);
  }, [to, duration]);
  return (
    <>
      {val.toLocaleString()}
      {suffix}
    </>
  );
}

// ── Skeleton shimmer ──────────────────────────────────────────────────────────
export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <div className={`skeleton ${className ?? ""}`} style={style} />;
}

// ── StreamingText — reveals text word-by-word (newest assistant msg only) ─────
export function StreamingText({
  text,
  active,
}: {
  text: string;
  active: boolean;
}) {
  const words = text.split(" ");
  const [count, setCount] = useState(active ? 0 : words.length);

  useEffect(() => {
    if (!active) {
      setCount(words.length);
      return;
    }
    setCount(0);
    let i = 0;
    // ~60 words/sec feels natural
    const id = setInterval(() => {
      i += 2;
      setCount(Math.min(i, words.length));
      if (i >= words.length) clearInterval(id);
    }, 32);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, active]);

  if (!active) return <>{text}</>;

  return (
    <>
      {words.slice(0, count).join(" ")}
      {count < words.length && (
        <motion.span
          className="stream-cursor"
          animate={{ opacity: [1, 0, 1] }}
          transition={{ duration: 0.6, repeat: Infinity }}
        >
          ▍
        </motion.span>
      )}
    </>
  );
}

// ── Toast system ──────────────────────────────────────────────────────────────
type ToastItem = { id: number; msg: string; type: "success" | "error" | "info" };
type ToastFn = (msg: string, type?: ToastItem["type"]) => void;

let _toast: ToastFn | null = null;

export function toast(msg: string, type: ToastItem["type"] = "success") {
  _toast?.(msg, type);
}

export function ToastPortal() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    _toast = (msg, type = "success") => {
      const id = Date.now();
      setItems((prev) => [...prev.slice(-4), { id, msg, type }]);
      setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 3200);
    };
    return () => {
      _toast = null;
    };
  }, []);

  return (
    <div className="toast-portal" aria-live="polite">
      <AnimatePresence>
        {items.map((t) => (
          <motion.div
            key={t.id}
            className={`toast toast-${t.type}`}
            initial={{ opacity: 0, y: -16, scale: 0.92 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -16, scale: 0.92 }}
            transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
            onClick={() => setItems((p) => p.filter((x) => x.id !== t.id))}
          >
            {t.msg}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
