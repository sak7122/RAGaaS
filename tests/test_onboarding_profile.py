import os

os.environ["RAGAAS_USE_MEMORY_STORE"] = "1"

from fastapi.testclient import TestClient

from backend.main import app, tenant_profile_store

client = TestClient(app)
ADMIN_A = {"Authorization": "Bearer tenant-a-token"}

VALID = {
    "company_size": "51-200",
    "role": "lnd",
    "primary_use": "onboarding",
    "country": "IN",
    "phone": "+91 98765 43210",
}


def test_profile_saves_name_and_onboarding() -> None:
    r = client.put("/api/tenant/profile", headers=ADMIN_A,
                   json={"name": "Acme Corp", "onboarding": VALID})
    assert r.status_code == 200, r.text
    assert tenant_profile_store.get_name("tenant-a") == "Acme Corp"
    assert tenant_profile_store.get_onboarding("tenant-a") == VALID


def test_profile_name_only_still_works() -> None:
    r = client.put("/api/tenant/profile", headers=ADMIN_A, json={"name": "Just a name"})
    assert r.status_code == 200


def test_onboarding_rejects_values_outside_vocabulary() -> None:
    for field, bad in [("company_size", "huge"), ("role", "ceo"),
                       ("primary_use", "fun"), ("country", "india"), ("phone", "call me")]:
        r = client.put("/api/tenant/profile", headers=ADMIN_A,
                       json={"name": "Acme", "onboarding": {**VALID, field: bad}})
        assert r.status_code == 422, f"{field}={bad!r} should be rejected"
