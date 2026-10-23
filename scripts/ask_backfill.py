"""Copy every existing Ask document (Firestore index) into the Vertex AI Search
data store, page by page. New uploads are mirrored automatically; run this once
after enabling ASK_ENGINE/ASK_DATASTORE, or again to repair.

    python scripts/ask_backfill.py              # all workspaces
    python scripts/ask_backfill.py --dry-run    # list what would be copied

Uses your gcloud application-default credentials against production Firestore.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import firebase_admin
from firebase_admin import firestore

from backend.ask_search import VertexAskSearch
from backend.index_store import FirestoreIndexStore

PROJECT = os.getenv("GCP_PROJECT_ID", "snappy-mapper-498223-b2")


def main() -> None:
    dry = "--dry-run" in sys.argv
    firebase_admin.initialize_app(options={"projectId": PROJECT})
    db = firestore.client()
    store = FirestoreIndexStore(db)
    ask = VertexAskSearch(PROJECT, os.getenv("ASK_ENGINE", "ragaas-ask"), os.getenv("ASK_DATASTORE", "ragaas-ask-kb"))

    docs = [d.to_dict() or {} for d in db.collection_group("documents").stream()]
    docs = [d for d in docs if d.get("tenant_id") and d.get("file_name")]
    print(f"{len(docs)} documents across {len({d['tenant_id'] for d in docs})} workspaces")
    total = 0
    for d in docs:
        tenant, name = d["tenant_id"], d["file_name"]
        chunks = store.doc_chunks(tenant, name, 20000)
        if not chunks:
            print(f"  skip {tenant}/{name}: no chunks")
            continue
        if dry:
            print(f"  would copy {tenant}/{name}: {len({c.get('page', 1) for c in chunks})} pages")
            continue
        try:
            n = ask.index_document(tenant, name, d.get("title") or name, chunks)
            total += n
            print(f"  {tenant}/{name}: {n} pages")
        except Exception as exc:
            print(f"  FAILED {tenant}/{name}: {exc}")
    print(f"done: {total} pages copied")


if __name__ == "__main__":
    main()
