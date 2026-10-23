"""Create the shared Vertex AI Search data store + engine that Ask answers from.

    python scripts/ask_setup_search.py            # create (idempotent) + set schema
    python scripts/ask_setup_search.py --status   # show what exists

One data store for all workspaces: every document carries structData.tenant_id
and every query filters on it (backend/ask_search.py), so new workspaces need no
setup. Enterprise tier + LLM add-on enables the Answer API, billed as Vertex AI
Search, which the GenAI App Builder trial credit covers.

Uses your gcloud application-default credentials.
"""
import json
import os
import sys
import time

import google.auth
import google.auth.transport.requests
import httpx

PROJECT = os.getenv("GCP_PROJECT_ID", "snappy-mapper-498223-b2")
DATA_STORE = os.getenv("ASK_DATASTORE", "ragaas-ask-kb")
ENGINE = os.getenv("ASK_ENGINE", "ragaas-ask")
BASE = f"https://discoveryengine.googleapis.com/v1/projects/{PROJECT}/locations/global/collections/default_collection"

SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
        "title": {"type": "string", "retrievable": True, "keyPropertyMapping": "title"},
        "tenant_id": {"type": "string", "indexable": True, "retrievable": True},
        "file_name": {"type": "string", "indexable": True, "retrievable": True},
        "page": {"type": "number", "indexable": True, "retrievable": True},
    },
}


def headers() -> dict:
    creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    creds.refresh(google.auth.transport.requests.Request())
    return {"Authorization": f"Bearer {creds.token}", "x-goog-user-project": PROJECT}


def wait(op: dict, h: dict) -> None:
    name = op.get("name", "")
    for _ in range(60):
        if op.get("done"):
            if "error" in op:
                sys.exit(f"operation failed: {op['error']}")
            return
        time.sleep(5)
        op = httpx.get(f"https://discoveryengine.googleapis.com/v1/{name}", headers=h, timeout=60).json()
    sys.exit(f"timed out waiting for {name}")


def main() -> None:
    h = headers()
    if "--status" in sys.argv:
        for kind, rid in (("dataStores", DATA_STORE), ("engines", ENGINE)):
            r = httpx.get(f"{BASE}/{kind}/{rid}", headers=h, timeout=60)
            print(kind, rid, r.status_code, r.json().get("name", r.text[:200]))
        return

    r = httpx.get(f"{BASE}/dataStores/{DATA_STORE}", headers=h, timeout=60)
    if r.status_code == 404:
        print("creating data store", DATA_STORE)
        r = httpx.post(f"{BASE}/dataStores", params={"dataStoreId": DATA_STORE}, headers=h, timeout=60, json={
            "displayName": "RAGaaS Ask knowledge base",
            "industryVertical": "GENERIC",
            "solutionTypes": ["SOLUTION_TYPE_SEARCH"],
            "contentConfig": "CONTENT_REQUIRED",
            "documentProcessingConfig": {
                "chunkingConfig": {"layoutBasedChunkingConfig": {"chunkSize": 500, "includeAncestorHeadings": True}},
                "defaultParsingConfig": {"layoutParsingConfig": {}},
            },
        })
        r.raise_for_status()
        wait(r.json(), h)
    else:
        print("data store exists", DATA_STORE)

    r = httpx.patch(f"{BASE}/dataStores/{DATA_STORE}/schemas/default_schema",
                    json={"jsonSchema": json.dumps(SCHEMA)}, headers=h, timeout=60)
    print("schema", r.status_code, r.json().get("name", r.text[:300]))
    if r.status_code < 300 and not r.json().get("done", True):
        wait(r.json(), h)

    r = httpx.get(f"{BASE}/engines/{ENGINE}", headers=h, timeout=60)
    if r.status_code == 404:
        print("creating engine", ENGINE)
        r = httpx.post(f"{BASE}/engines", params={"engineId": ENGINE}, headers=h, timeout=60, json={
            "displayName": "RAGaaS Ask",
            "industryVertical": "GENERIC",
            "solutionType": "SOLUTION_TYPE_SEARCH",
            "dataStoreIds": [DATA_STORE],
            "searchEngineConfig": {"searchTier": "SEARCH_TIER_ENTERPRISE", "searchAddOns": ["SEARCH_ADD_ON_LLM"]},
        })
        r.raise_for_status()
        wait(r.json(), h)
    else:
        print("engine exists", ENGINE)
    print("ready:", DATA_STORE, ENGINE)


if __name__ == "__main__":
    main()
