import { ReactNode } from "react";
import { RefreshCcw } from "lucide-react";

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
    <div className="quota-track">
      <div className={`quota-fill ${cls}`} style={{ width: `${pct}%` }} />
    </div>
  );
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
  const dotClass = online ? "" : authState === "Signing in…" ? "pending" : "offline";
  const chipLabel = status?.tenant_id ?? authState;

  const queriesUsed = status?.queries_used ?? 0;
  const queryLimit  = status?.query_limit  ?? 1000;
  const docs        = status?.documents    ?? 0;

  return (
    <aside className="sidebar">
      {tenants.length > 0 && (
        <div className="sidebar-group">
          <span className="sidebar-label">Tenant</span>
          <select
            className="tenant-select"
            value={tenantEmail}
            onChange={(e) => onTenantChange(e.target.value)}
          >
            {tenants.map((t) => (
              <option key={t.email} value={t.email}>{t.label}</option>
            ))}
          </select>
        </div>
      )}

      <div className="sidebar-group">
        <span className="sidebar-label">Auth</span>
        <div className="auth-chip">
          <span className={`auth-chip-dot ${dotClass}`} />
          <span className="auth-chip-label">{chipLabel}</span>
        </div>
      </div>

      <div className="sidebar-group">
        <span className="sidebar-label">Usage</span>
        <div className="stats-grid">
          <div className="stat-cell">
            <span className="stat-value">{docs}</span>
            <span className="stat-meta">documents</span>
          </div>
          <div className="stat-cell">
            <span className="stat-value">{queriesUsed}</span>
            <span className="stat-meta">queries used</span>
          </div>
        </div>
        <QuotaBar used={queriesUsed} limit={queryLimit} />
        <span style={{ fontSize: 11, color: "var(--ink-48)", letterSpacing: "-0.12px" }}>
          {queriesUsed} / {queryLimit} daily limit
        </span>
      </div>

      {extraSlot}

      <div style={{ marginTop: "auto" }}>
        <button type="button" className="btn-utility" onClick={onRefresh}>
          <RefreshCcw size={14} />
          Refresh status
        </button>
      </div>
    </aside>
  );
}
