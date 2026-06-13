from __future__ import annotations

import os
import sys
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    env: str                    # "development" | "production"
    firebase_project_id: str
    use_emulator: bool
    gcp_project_id: str
    cors_origin_regex: str
    gcs_bucket: str             # GCS2 bucket for PDF storage (prod) | "" (dev)


def _load() -> Config:
    env = os.getenv("RAGAAS_ENV", "development")
    use_emulator = bool(
        os.getenv("FIREBASE_AUTH_EMULATOR_HOST")
        or os.getenv("FIRESTORE_EMULATOR_HOST")
    )

    if env == "development":
        cors = r"http://(localhost|127\.0\.0\.1)(:\d+)?"
    else:
        # Sec fix #6: require explicit CORS_ORIGIN_REGEX in prod — no permissive default
        cors = os.getenv("CORS_ORIGIN_REGEX")
        if not cors:
            _abort("CORS_ORIGIN_REGEX is required in production")

    cfg = Config(
        env=env,
        firebase_project_id=os.getenv("FIREBASE_PROJECT_ID", "ragaas-local"),
        use_emulator=use_emulator,
        gcp_project_id=os.getenv("GCP_PROJECT_ID", "ragaas-local"),
        cors_origin_regex=cors,  # type: ignore[arg-type]
        gcs_bucket=os.getenv("GCS_BUCKET", ""),
    )

    # Sec fix #6: validate required prod env vars on startup
    if env == "production":
        if cfg.firebase_project_id == "ragaas-local":
            _abort("FIREBASE_PROJECT_ID must be set to real project in production")
        if cfg.gcp_project_id == "ragaas-local":
            _abort("GCP_PROJECT_ID must be set to real project in production")
        if not cfg.gcs_bucket:
            _abort("GCS_BUCKET must be set in production")

    return cfg


def _abort(msg: str) -> None:
    print(f"[ragaas] FATAL config error: {msg}", file=sys.stderr)
    sys.exit(1)


config = _load()
