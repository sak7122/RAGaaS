# ==============================================================================
# RAGaaS Developer Skill: Simulate Tenant Quota Circuit Breaker
# ==============================================================================
# This Python script sends requests to the local FastAPI backend to verify that
# the tenant query limit (1,000 queries) triggers an HTTP 429 error.
# ==============================================================================

import requests
import sys
import time

BACKEND_URL = "http://127.0.0.1:8000/api/chat"
MOCK_TENANT_TOKEN = "mock-tenant-token-abc"

def run_simulation(request_count=1005):
    print(f"[*] Starting Quota Circuit Breaker simulation: {request_count} requests...")
    headers = {
        "Authorization": f"Bearer {MOCK_TENANT_TOKEN}",
        "Content-Type": "application/json"
    }
    payload = {
        "message": "Hello AI, this is a test query."
    }

    successful_requests = 0
    quota_blocked_requests = 0
    start_time = time.time()

    for i in range(1, request_count + 1):
        try:
            # We mock/skip lag for testing speed
            response = requests.post(BACKEND_URL, json=payload, headers=headers)
            
            if response.status_code == 200:
                successful_requests += 1
            elif response.status_code == 429:
                quota_blocked_requests += 1
                if quota_blocked_requests == 1:
                    print(f"\n[+] SUCCESS: Circuit Breaker triggered on request #{i}!")
                    print(f"[+] Response Status: 429 Too Many Requests")
                    print(f"[+] Response Body: {response.json()}\n")
            else:
                print(f"[-] Unexpected response on request #{i}: {response.status_code}")
                
        except requests.exceptions.ConnectionError:
            print("\n[-] Error: Could not connect to local FastAPI server. Is it running on port 8000?")
            sys.exit(1)

        # Print progress status line
        if i % 100 == 0 or i == request_count:
            print(f"    Progress: {i}/{request_count} requests sent...")

    elapsed_time = time.time() - start_time
    print("\n" + "="*50)
    print("SIMULATION SUMMARY")
    print("="*50)
    print(f"Total Requests Sent : {request_count}")
    print(f"Successful Queries  : {successful_requests}")
    print(f"Blocked (429) Ops   : {quota_blocked_requests}")
    print(f"Elapsed Time        : {elapsed_time:.2f} seconds")
    print("="*50)

    if quota_blocked_requests > 0:
        print("[*] TEST PASSED: Quota Circuit Breaker successfully protected downstream resources.")
    else:
        print("[-] TEST FAILED: All requests succeeded. Quota middleware did not trigger.")

if __name__ == "__main__":
    run_simulation()
