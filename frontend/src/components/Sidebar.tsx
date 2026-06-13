import { ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { RefreshCcw, Shield, FileText, Users } from "lucide-react";

type Status = {
  tenant_id: string;
  queries_used: number;
  query_limit: number;
  documents: number;
};

type Tenant = { label: string; email: string };

interface SidebarProps {
  tenants: Tenant[];
  tenantEmail: string;
  onTenantChange: (email: string) => void;
  status: Status | null;
  authState: string;
  online: boolean;
  onRefresh: () => void;
  extraSlot?: ReactNode;
}

function QuotaBar({ used, limit }: { used: number; limit: number }) {
  const pct = limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
  const cls = pct >= 90 ? "danger" : pct >= 70 ? "warn" : "";
  return (
    <div className="quota-wrap">
      <div className="quota-track">
        <motion.div
          className={`quota-fill ${cls}`}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.8, ease: [0.4, 0, 0.2, 1] }}
        />
      </div>
      <span className="quota-label">
        {used.toLocaleString()} / {limit.toLocaleString()} queries today
      </span>
    </div>
  );
}

function AnimatedNum({ value }: { value: number }) {
  return (
    <motion.span
      key={value}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className="stat-num"
    >
      {value.toLocaleString()}
    </motion.span>
  );
}

function Avatar({ label }: { label: string }) {
  return <span className="avatar">{label.charAt(0).toUpperCase()}</span>;
}

export function Sidebar({
  tenants,
  tenantEmail,
  onTenantChange,
  status,
  authState,
  online,
  onRefresh,
  extraSlot,
}: SidebarProps) {
  const dotClass  = online ? "" : authState === "Signing in…" ? "pending" : "offline";
  const chipLabel = status?.tenant_id ?? (online ? "connected" : authState);
  const queriesUsed = status?.queries_used ?? 0;
  const queryLimit  = status?.query_limit  ?? 1000;
  const docs        = status?.documents    ?? 0;

  const sectionVariants = {
    hidden: { opacity: 0, y: 10 },
    visible: (i: number) => ({
      opacity: 1,
      y: 0,
      transition: { delay: i * 0.06, duration: 0.3, ease: "easeOut" },
    }),
  };

  return (
    <aside className="sidebar">

      {/* Workspace / tenant switcher */}
      <AnimatePresence>
        {tenants.length > 0 && (
          <motion.div
            className="sidebar-section"
            custom={0}
            variants={sectionVariants}
            initial="hidden"
            animate="visible"
          >
            <span className="sidebar-label">Workspace</span>
            <div className="tenant-pills">
              {tenants.map((t) => (
                <motion.button
                  key={t.email}
                  type="button"
                  className={`tenant-pill${tenantEmail === t.email ? " active" : ""}`}
                  onClick={() => onTenantChange(t.email)}
                  whileTap={{ scale: 0.96 }}
                  layout
                >
                  <span className="tenant-pill-dot" />
                  {t.label}
                </motion.button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Account */}
      <motion.div
        className="sidebar-section"
        custom={1}
        variants={sectionVariants}
        initial="hidden"
        animate="visible"
      >
        <span className="sidebar-label">Account</span>
        <div className="auth-chip">
          <Avatar label={chipLabel} />
          <div className="auth-chip-body">
            <span className="auth-chip-label">{chipLabel}</span>
            <span className={`auth-chip-status ${dotClass}`}>
              <span className={`auth-dot ${dotClass}`} />
              {online ? "online" : authState === "Signing in…" ? "connecting…" : "offline"}
            </span>
          </div>
        </div>
      </motion.div>

      {/* Usage */}
      <motion.div
        className="sidebar-section"
        custom={2}
        variants={sectionVariants}
        initial="hidden"
        animate="visible"
      >
        <span className="sidebar-label">Usage</span>
        <div className="stats-row">
          <div className="stat-pill">
            <AnimatedNum value={docs} />
            <span className="stat-unit">
              <FileText size={9} style={{ display: "inline", marginRight: 3, verticalAlign: "middle" }} />
              docs
            </span>
          </div>
          <div className="stat-pill">
            <AnimatedNum value={queriesUsed} />
            <span className="stat-unit">queries</span>
          </div>
        </div>
        <QuotaBar used={queriesUsed} limit={queryLimit} />
      </motion.div>

      {/* Documents + Members */}
      <motion.div
        custom={3}
        variants={sectionVariants}
        initial="hidden"
        animate="visible"
        style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}
      >
        {extraSlot}
      </motion.div>

      {/* Footer */}
      <motion.div
        className="sidebar-footer"
        custom={4}
        variants={sectionVariants}
        initial="hidden"
        animate="visible"
      >
        <button type="button" className="btn-ghost" onClick={onRefresh}>
          <RefreshCcw size={12} />
          Refresh
        </button>
        <a href="/privacy" className="btn-ghost" target="_blank" rel="noopener noreferrer">
          <Shield size={12} />
          Privacy
        </a>
      </motion.div>

    </aside>
  );
}
