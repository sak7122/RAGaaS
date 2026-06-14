import React, { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Upload, CheckCircle2, XCircle, Loader, FileText } from "lucide-react";

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
}

function uid(): string {
  return Math.random().toString(36).slice(2);
}

export function UploadBar({ apiUrl, authToken, disabled, onComplete }: UploadBarProps) {
  const [queue, setQueue]       = useState<QueueItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const startedRef              = useRef(new Set<string>());
  const tokenRef                = useRef(authToken);

  useEffect(() => { tokenRef.current = authToken; }, [authToken]);

  function processFiles(files: File[]) {
    const MAX_BYTES = 50 * 1024 * 1024;
    const ALLOWED = [".pdf", ".docx"];
    const newItems: QueueItem[] = files.slice(0, 10).map((file) => {
      if (!ALLOWED.some((ext) => file.name.toLowerCase().endsWith(ext)))
        return { id: uid(), file, status: "error" as FileStatus, progress: 0, error: "PDF or .docx only" };
      if (file.size > MAX_BYTES)
        return { id: uid(), file, status: "error" as FileStatus, progress: 0, error: "Exceeds 50 MB" };
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
          accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          multiple
          disabled={disabled}
          onChange={handleChange}
          style={{ display: "none" }}
        />

        <span className="upload-zone-hint">
          or drag &amp; drop · PDF or Word (.docx) · max 50 MB · up to 10 files
        </span>

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
