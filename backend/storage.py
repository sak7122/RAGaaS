"""
Storage backends for PDF binary files.
Dev  → LocalStorage  (local_data/uploads/)
Prod → GCSStorage    (gs://<bucket>/<tenant_id>/<file_name>)
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Protocol, runtime_checkable

log = logging.getLogger("ragaas")


@runtime_checkable
class StorageBackend(Protocol):
    def upload(self, tenant_id: str, file_name: str, content: bytes) -> str:
        """Store PDF bytes; return a URI/path string for logging."""
        ...

    def delete(self, tenant_id: str, file_name: str) -> None:
        """Delete a PDF; silently no-ops if not found."""
        ...

    def delete_tenant(self, tenant_id: str) -> None:
        """Delete all files for a tenant."""
        ...


# ── Dev: local filesystem ─────────────────────────────────────────────────────

class LocalStorage:
    def __init__(self, base_dir: Path) -> None:
        self._base = base_dir

    def _path(self, tenant_id: str, file_name: str) -> Path:
        return self._base / tenant_id / file_name

    def upload(self, tenant_id: str, file_name: str, content: bytes) -> str:
        dest = self._path(tenant_id, file_name)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(content)
        return str(dest)

    def delete(self, tenant_id: str, file_name: str) -> None:
        p = self._path(tenant_id, file_name)
        if p.exists():
            p.unlink()

    def delete_tenant(self, tenant_id: str) -> None:
        import shutil
        tenant_dir = self._base / tenant_id
        if tenant_dir.exists():
            shutil.rmtree(tenant_dir)


# ── Prod: Google Cloud Storage ────────────────────────────────────────────────

class GCSStorage:
    def __init__(self, bucket_name: str) -> None:
        from google.cloud import storage as gcs
        self._client = gcs.Client()
        self._bucket = self._client.bucket(bucket_name)
        self._bucket_name = bucket_name

    def _blob_name(self, tenant_id: str, file_name: str) -> str:
        return f"{tenant_id}/{file_name}"

    def upload(self, tenant_id: str, file_name: str, content: bytes) -> str:
        blob_name = self._blob_name(tenant_id, file_name)
        blob = self._bucket.blob(blob_name)
        blob.upload_from_string(content, content_type="application/pdf")
        uri = f"gs://{self._bucket_name}/{blob_name}"
        log.info("gcs_upload bucket=%s blob=%s bytes=%d", self._bucket_name, blob_name, len(content))
        return uri

    def delete(self, tenant_id: str, file_name: str) -> None:
        blob_name = self._blob_name(tenant_id, file_name)
        blob = self._bucket.blob(blob_name)
        try:
            blob.delete()
            log.info("gcs_delete bucket=%s blob=%s", self._bucket_name, blob_name)
        except Exception:
            pass  # already gone

    def delete_tenant(self, tenant_id: str) -> None:
        prefix = f"{tenant_id}/"
        blobs = list(self._bucket.list_blobs(prefix=prefix))
        for blob in blobs:
            blob.delete()
        log.info("gcs_delete_tenant bucket=%s prefix=%s count=%d", self._bucket_name, prefix, len(blobs))


# ── Factory ───────────────────────────────────────────────────────────────────

def create_storage_backend(env: str, base_dir: Path, gcs_bucket: str) -> StorageBackend:
    if env == "production":
        log.info("storage=GCS bucket=%s", gcs_bucket)
        return GCSStorage(gcs_bucket)
    log.info("storage=local base=%s", base_dir)
    return LocalStorage(base_dir)
