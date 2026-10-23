import React, { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Upload, CheckCircle2, XCircle, Loader, FileText, Globe, Mic, Square } from "lucide-react";

// Every type the backend reads (backend/ingest.py): text formats are parsed, scans,
// photos and recordings are read by Gemini.
const ALLOWED = [".pdf", ".docx", ".xlsx", ".csv", ".pptx", ".txt", ".md", ".html", ".htm",
  ".jpg", ".jpeg", ".png", ".webp", ".heic", ".mp3", ".m4a", ".wav", ".ogg", ".webm", ".aac", ".flac"];
const READ_BY_AI = /\.(jpe?g|png|webp|heic|mp3|m4a|wav|ogg|webm|aac|flac)$/i;
const MAX_AI_BYTES = 19 * 1024 * 1024;

type FileStatus = "queued" | "uploading" | "done" | "error";

type QueueItem = {
  id: string;
  file: File;
  status: FileStatus;
  progress: number;
  error?: string;
};

interface UploadBarProps {
  apiUrl: string;
  authToken: string;
  disabled: boolean;
  onComplete: () => void;
  onImportUrl?: (url: string, wholeSite: boolean) => Promise<string | null>;   // error text, or null when imported
}

function uid(): string {
  return Math.random().toString(36).slice(2);
}

export function UploadBar({ apiUrl, authToken, disabled, onComplete, onImportUrl }: UploadBarProps) {
  const [queue, setQueue]       = useState<QueueItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const startedRef              = useRef(new Set<string>());
  const tokenRef                = useRef(authToken);

  useEffect(() => { tokenRef.current = authToken; }, [authToken]);

  function processFiles(files: File[]) {
    const MAX_BYTES = 30 * 1024 * 1024;
    const newItems: QueueItem[] = files.slice(0, 10).map((file) => {
      if (!ALLOWED.some((ext) => file.name.toLowerCase().endsWith(ext)))
        return { id: uid(), file, status: "error" as FileStatus, progress: 0, error: "This file type isn't supported" };
      if (file.size > MAX_BYTES)
        return { id: uid(), file, status: "error" as FileStatus, progress: 0, error: "Exceeds 30 MB" };
      if (READ_BY_AI.test(file.name) && file.size > MAX_AI_BYTES)
        return { id: uid(), file, status: "error" as FileStatus, progress: 0, error: "Photos and audio up to 19 MB" };
      return { id: uid(), file, status: "queued" as FileStatus, progress: 0 };
    });
    setQueue((q) => [...q.filter((i) => i.status !== "done"), ...newItems]);
  }

  function uploadFile(item: QueueItem) {
    const data = new FormData();
    data.append("file", item.file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${apiUrl}/api/upload`);
    xhr.setRequestHeader("Authorization", `Bearer ${tokenRef.current}`);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        setQueue((q) => q.map((i) => i.id === item.id ? { ...i, progress: pct } : i));
      }
    };
    xhr.onload = () => {
      const ok = xhr.status < 300;
      let errMsg: string | undefined;
      try { if (!ok) errMsg = JSON.parse(xhr.responseText).detail ?? "Upload failed"; }
      catch { errMsg = "Upload failed"; }
      setQueue((q) => q.map((i) =>
        i.id === item.id ? { ...i, status: ok ? "done" : "error", progress: ok ? 100 : 0, error: errMsg } : i,
      ));
      if (ok) onComplete();
    };
    xhr.onerror = () => {
      setQueue((q) => q.map((i) => i.id === item.id ? { ...i, status: "error", error: "Network error" } : i));
    };
    xhr.send(data);
  }

  // Dispatcher: mark queued → uploading (max 3 concurrent)
  useEffect(() => {
    const uploading = queue.filter((i) => i.status === "uploading").length;
    const queued    = queue.filter((i) => i.status === "queued");
    const slots     = Math.max(0, 3 - uploading);
    if (slots === 0 || queued.length === 0) return;
    const toStart = queued.slice(0, slots);
    setQueue((q) =>
      q.map((i) => toStart.some((s) => s.id === i.id) ? { ...i, status: "uploading" } : i),
    );
  }, [queue]);

  // Start XHR for newly-uploading items
  useEffect(() => {
    const toStart = queue.filter((i) => i.status === "uploading" && !startedRef.current.has(i.id));
    for (const item of toStart) {
      startedRef.current.add(item.id);
      uploadFile(item);
    }
  }, [queue]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length) processFiles(files);
    e.target.value = "";
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    if (!disabled) setDragging(true);
  }
  function handleDragLeave() { setDragging(false); }
  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (disabled) return;
    processFiles(Array.from(e.dataTransfer.files));
  }

  const [urlOpen, setUrlOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [urlMsg, setUrlMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [wholeSite, setWholeSite] = useState(true);

  async function importUrl(e: React.FormEvent) {
    e.preventDefault();
    if (!onImportUrl) return;
    setImporting(true); setUrlMsg(null);
    const err = await onImportUrl(url.trim(), wholeSite);
    setImporting(false);
    if (err) setUrlMsg({ ok: false, text: err });
    else {
      setUrlMsg({ ok: true, text: wholeSite ? "Site imported. It's searchable now and re-read weekly." : "Imported. It's searchable now." });
      setUrl(""); onComplete();
    }
  }

  const active   = queue.filter((i) => i.status === "uploading" || i.status === "queued");
  const hasItems = queue.length > 0;

  return (
    <motion.div
      className={`upload-zone${dragging ? " drag-over" : ""}${disabled ? " disabled" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="upload-zone-inner">
        <motion.div
          animate={{
            scale: dragging ? 1.2 : 1,
            color: dragging ? "var(--primary)" : "var(--ink-48)",
          }}
          transition={{ type: "spring", stiffness: 400, damping: 22 }}
        >
          <Upload size={15} />
        </motion.div>

        <label htmlFor="pdf-upload" className="upload-zone-label" aria-disabled={disabled}>
          {active.length > 0
            ? `${active.filter((i) => i.status === "uploading").length} uploading…`
            : dragging
            ? "Drop files here"
            : "Upload documents"}
        </label>

        <input
          id="pdf-upload"
          type="file"
          accept={ALLOWED.join(",")}
          multiple
          disabled={disabled}
          onChange={handleChange}
          style={{ display: "none" }}
        />

        <span className="upload-zone-hint">
          or drag &amp; drop · PDF, Word, Excel, CSV, slides, photos of documents, audio · max 30 MB
        </span>
        {onImportUrl && (
          <button type="button" className="up-extra" disabled={disabled} onClick={() => setUrlOpen((v) => !v)} aria-expanded={urlOpen}>
            <Globe size={13} aria-hidden="true" /> Web page
          </button>
        )}
        <VoiceNote disabled={disabled} onRecorded={(f) => processFiles([f])} />

        <AnimatePresence>
          {hasItems && active.length === 0 && (
            <motion.button
              type="button"
              className="btn-ghost-sm"
              onClick={() => setQueue([])}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ duration: 0.15 }}
            >
              Clear
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {urlOpen && onImportUrl && (
          <motion.form className="up-url" onSubmit={importUrl}
            initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
            <input type="url" required value={url} onChange={(e) => setUrl(e.target.value)} disabled={importing}
              placeholder="https://yourcompany.com/help" aria-label="Web page address" autoFocus />
            <span className="up-scope" role="radiogroup" aria-label="What to import">
              <label><input type="radio" name="up-scope" checked={wholeSite} onChange={() => setWholeSite(true)} /> Whole site (up to 40 pages)</label>
              <label><input type="radio" name="up-scope" checked={!wholeSite} onChange={() => setWholeSite(false)} /> Just this page</label>
            </span>
            <button type="submit" className="btn-primary-sm" disabled={importing || url.length < 8}>
              {importing ? (wholeSite ? "Reading the site…" : "Importing…") : "Import"}
            </button>
            {urlMsg && <span className={`up-url-msg${urlMsg.ok ? " is-ok" : ""}`} role="status">{urlMsg.text}</span>}
          </motion.form>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {hasItems && (
          <motion.div
            className="upload-queue"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            style={{ overflow: "hidden" }}
          >
            <AnimatePresence initial={false}>
              {queue.map((item) => (
                <motion.div
                  key={item.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 10 }}
                  transition={{ duration: 0.18 }}
                >
                  <UploadItem item={item} />
                </motion.div>
              ))}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function UploadItem({ item }: { item: QueueItem }) {
  const icon: Record<FileStatus, React.ReactNode> = {
    queued:    <FileText     size={12} color="var(--ink-48)" />,
    uploading: <Loader       size={12} color="var(--primary)" className="spin" />,
    done:      <CheckCircle2 size={12} color="var(--green)" />,
    error:     <XCircle     size={12} color="var(--red)" />,
  };
  return (
    <div className="upload-item">
      {icon[item.status]}
      <span className="upload-item-name">{item.file.name}</span>
      {item.status === "uploading" && (
        <div className="upload-item-track">
          <motion.div
            className="upload-item-fill"
            animate={{ width: `${item.progress}%` }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            style={{ width: 0 }}
          />
        </div>
      )}
      {item.status === "error"  && <span className="upload-item-error">{item.error}</span>}
      {item.status === "done"   && <span className="upload-item-done">indexed</span>}
      {item.status === "queued" && <span className="upload-item-queued">queued</span>}
    </div>
  );
}

/** Record a voice note in the browser and upload it; the backend transcribes it into
 * a searchable document (handy for "how we do X" explanations nobody has written down). */
function VoiceNote({ disabled, onRecorded }: { disabled: boolean; onRecorded: (f: File) => void }) {
  const [rec, setRec] = useState<MediaRecorder | null>(null);
  const [secs, setSecs] = useState(0);
  const [error, setError] = useState("");
  const timer = useRef<number | null>(null);
  if (typeof window === "undefined" || !("MediaRecorder" in window) || !navigator.mediaDevices) return null;

  async function start() {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4";
      const r = new MediaRecorder(stream, { mimeType: type });
      const parts: Blob[] = [];
      r.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (timer.current) window.clearInterval(timer.current);
        const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
        const ext = type === "audio/webm" ? "webm" : "m4a";
        onRecorded(new File(parts, `voice-note-${stamp}.${ext}`, { type }));
        setRec(null);
      };
      r.start();
      setSecs(0);
      timer.current = window.setInterval(() => setSecs((s) => s + 1), 1000);
      setRec(r);
    } catch {
      setError("Microphone access is blocked.");
    }
  }
  return (
    <>
      <button type="button" className={`up-extra${rec ? " is-rec" : ""}`} disabled={disabled}
        onClick={() => (rec ? rec.stop() : start())} aria-pressed={!!rec}
        title={rec ? "Stop and upload" : "Record a voice note as a document"}>
        {rec ? <><Square size={11} fill="currentColor" aria-hidden="true" /> {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")} · Stop</>
             : <><Mic size={13} aria-hidden="true" /> Voice note</>}
      </button>
      {error && <span className="up-url-msg" role="status">{error}</span>}
    </>
  );
}
