import { FormEvent, useState } from "react";
import { UserPlus, Trash2, ChevronDown } from "lucide-react";

export type Member = {
  uid: string;
  email: string;
  role: "admin" | "uploader" | "viewer";
  invited_at: string;
  joined_at: string | null;
};

const ROLE_COLORS: Record<string, string> = {
  admin:    "var(--primary)",
  uploader: "var(--green)",
  viewer:   "var(--ink-48)",
};

interface MembersPanelProps {
  members: Member[];
  currentUid: string;
  onInvite: (email: string, role: string) => Promise<{ email_sent?: boolean; invite_link?: string } | void>;
  onRemove: (uid: string) => Promise<void>;
  onChangeRole: (uid: string, role: string) => Promise<void>;
}

export function MembersPanel({ members, currentUid, onInvite, onRemove, onChangeRole }: MembersPanelProps) {
  const [email, setEmail]     = useState("");
  const [role, setRole]       = useState("viewer");
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError]     = useState("");
  const [notice, setNotice]   = useState<{ msg: string; link?: string } | null>(null);

  async function handleInvite(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setInviting(true);
    setError("");
    setNotice(null);
    const to = email.trim();
    try {
      const result = await onInvite(to, role);
      setEmail("");
      if (result && result.email_sent) {
        setNotice({ msg: `Invite emailed to ${to}` });
      } else {
        // SMTP not configured — surface the link so the admin can share it
        setNotice({ msg: `Invite created — email not configured. Share this link:`, link: result?.invite_link });
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Invite failed");
    } finally {
      setInviting(false);
    }
  }

  async function handleRemove(uid: string) {
    setRemoving(uid);
    try { await onRemove(uid); }
    catch { /* parent shows error */ }
    finally { setRemoving(null); }
  }

  return (
    <div className="sidebar-group">
      <span className="sidebar-label">Team</span>

      <div className="members-list">
        {members.map((m) => (
          <div key={m.uid} className="member-row">
            <div className="member-info">
              <span className="member-email">{m.email}</span>
              <span className="member-status">{m.joined_at ? "active" : "invited"}</span>
            </div>
            <select
              className="role-select"
              value={m.role}
              disabled={m.uid === currentUid}
              onChange={(e) => onChangeRole(m.uid, e.target.value)}
              style={{ color: ROLE_COLORS[m.role] }}
            >
              <option value="admin">admin</option>
              <option value="uploader">uploader</option>
              <option value="viewer">viewer</option>
            </select>
            {m.uid !== currentUid && (
              <button
                type="button"
                className="doc-delete"
                disabled={removing === m.uid}
                onClick={() => handleRemove(m.uid)}
                title="Remove member"
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
        ))}
        {members.length === 0 && (
          <span style={{ fontSize: 11, color: "var(--ink-48)" }}>No members yet</span>
        )}
      </div>

      <form className="invite-form" onSubmit={handleInvite}>
        <input
          type="email"
          className="invite-input"
          placeholder="email@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          disabled={inviting}
        />
        <select
          className="role-select"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          disabled={inviting}
        >
          <option value="viewer">viewer</option>
          <option value="uploader">uploader</option>
          <option value="admin">admin</option>
        </select>
        <button type="submit" className="btn-invite" disabled={inviting || !email.trim()}>
          <UserPlus size={13} />
          {inviting ? "…" : "Invite"}
        </button>
      </form>
      {error && <span style={{ fontSize: 11, color: "var(--red)" }}>{error}</span>}
      {notice && (
        <div style={{ fontSize: 11, color: "var(--ink-48)", marginTop: 4 }}>
          <span style={{ color: notice.link ? "var(--ink-48)" : "var(--green)" }}>{notice.msg}</span>
          {notice.link && (
            <button
              type="button"
              className="btn-ghost-sm"
              style={{ marginLeft: 6 }}
              onClick={() => navigator.clipboard?.writeText(notice.link!)}
            >
              Copy link
            </button>
          )}
        </div>
      )}
    </div>
  );
}
