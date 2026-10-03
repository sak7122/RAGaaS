"""Mark Academy entitlement fields filterable on a tenant's Vertex AI Search data store.

Run once per tenant after `terraform apply` creates academy-kb-{suffix}:
    python scripts/academy_setup_search.py pilot [other-suffix ...]

Without this, the `sensitivity <= N AND dept_tags: ANY(...)` filter used by
backend/academy/search.py is rejected (fields not indexable).
"""
import json
import os
import sys

import google.auth
import google.auth.transport.requests
import httpx

PROJECT = os.getenv("GCP_PROJECT_ID", "snappy-mapper-498223-b2")

SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
        # key property: retrievable only (Vertex rejects indexable/searchable here)
        "title": {"type": "string", "retrievable": True, "keyPropertyMapping": "title"},
        "sensitivity": {"type": "number", "indexable": True, "retrievable": True},
        "dept_tags": {"type": "array", "items": {"type": "string", "indexable": True, "retrievable": True}},
        "role_tags": {"type": "array", "items": {"type": "string", "indexable": True, "retrievable": True}},
    },
}


def main(suffixes: list[str]) -> None:
    creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    creds.refresh(google.auth.transport.requests.Request())
    headers = {"Authorization": f"Bearer {creds.token}", "x-goog-user-project": PROJECT}
    for suffix in suffixes:
        url = (f"https://discoveryengine.googleapis.com/v1/projects/{PROJECT}/locations/global"
               f"/collections/default_collection/dataStores/academy-kb-{suffix}/schemas/default_schema")
        r = httpx.patch(url, json={"jsonSchema": json.dumps(SCHEMA)}, headers=headers, timeout=60)
        print(f"academy-kb-{suffix}: {r.status_code} {r.json().get('name', r.text[:200])}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1:])
