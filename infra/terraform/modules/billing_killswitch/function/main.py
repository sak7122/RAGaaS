"""Billing kill switch — unlinks billing from the project when net spend
(after credits) exceeds the budget.

Triggered by the budget's Pub/Sub notifications. Budget messages arrive a few
times a day, so this is a *near*-hard cap: a small overage past the budget is
possible between notifications.

Unlinking billing stops every paid service in the project (Cloud Run, Vertex,
Firestore beyond free quota, ...). Firebase Hosting + Auth keep working on the
free Spark tier. Re-enable billing manually in the console after investigating.
"""
from __future__ import annotations

import base64
import json
import os

import functions_framework
from google.cloud import billing_v1

PROJECT_ID = os.environ["TARGET_PROJECT_ID"]
# "true" → log what would happen but never unlink (for testing the wiring).
DRY_RUN = os.environ.get("DRY_RUN", "false").lower() == "true"


@functions_framework.cloud_event
def stop_billing(cloud_event) -> None:
    payload = json.loads(base64.b64decode(cloud_event.data["message"]["data"]).decode())
    cost = float(payload.get("costAmount", 0))
    budget = float(payload.get("budgetAmount", 0))
    currency = payload.get("currencyCode", "")
    print(f"[killswitch] project={PROJECT_ID} cost={cost} budget={budget} {currency}")

    if budget <= 0 or cost <= budget:
        print("[killswitch] under budget — no action")
        return

    client = billing_v1.CloudBillingClient()
    name = f"projects/{PROJECT_ID}"
    if not client.get_project_billing_info(name=name).billing_enabled:
        print("[killswitch] billing already disabled")
        return

    if DRY_RUN:
        print("[killswitch] DRY_RUN — would disable billing now")
        return

    client.update_project_billing_info(
        name=name,
        project_billing_info=billing_v1.ProjectBillingInfo(billing_account_name=""),
    )
    print(f"[killswitch] BILLING DISABLED for {PROJECT_ID} (cost {cost} > budget {budget} {currency})")
