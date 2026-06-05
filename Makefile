# RAGaaS — Dev task runner
# Usage: make <target>
# Requires: make (git bash / WSL / choco install make), docker, node, python

.PHONY: dev stop restart logs frontend backend emulators test smoke reset clean

# ── Full stack ────────────────────────────────────────────────────────────────

dev: stop backend frontend
	@echo "Stack up: backend=:8000  frontend=:5173"

stop:
	@echo "Stopping backend..."
	-docker compose down 2>/dev/null || true
	@echo "Freeing port 5173..."
	-powershell -Command "$$p = (Get-NetTCPConnection -LocalPort 5173 -ErrorAction SilentlyContinue).OwningProcess; if ($$p) { Stop-Process -Id $$p -Force }" 2>/dev/null || true

restart: stop dev

# ── Individual services ───────────────────────────────────────────────────────

emulators:
	@echo "Starting Firebase emulators (Auth :9099, Firestore :8080)..."
	powershell -File scripts/start_emulators.ps1

backend:
	@echo "Building + starting backend container..."
	docker compose up -d --build backend
	@echo "Waiting for health check..."
	docker compose exec backend python -c "import time; time.sleep(5)"
	@echo "Backend ready at http://127.0.0.1:8000"

frontend:
	@echo "Starting Vite on :5173 (strictPort)..."
	npm run dev &

# ── Logs ─────────────────────────────────────────────────────────────────────

logs:
	docker compose logs -f backend

# ── Testing ───────────────────────────────────────────────────────────────────

test:
	python -m pytest tests/ -v

smoke:
	@echo "=== Health ===" && curl -s http://127.0.0.1:8000/api/health
	@echo "\n=== Auth 401 ===" && curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:8000/api/chat -H "Content-Type: application/json" -d '{"message":"test"}'
	@echo "\n=== Tenant demo ===" && curl -s http://127.0.0.1:8000/api/tenant/status -H "Authorization: Bearer mock-tenant-token-abc"

reset:
	curl -s -X POST http://127.0.0.1:8000/api/dev/reset

# ── Build ─────────────────────────────────────────────────────────────────────

build:
	npm run build

docker-build:
	docker build --target dev -t ragaas-backend:dev .
	docker build --target prod -t ragaas-backend:prod .

# ── Cleanup ───────────────────────────────────────────────────────────────────

clean: stop
	docker image rm ragaas-backend:dev ragaas-backend:prod 2>/dev/null || true
	rm -rf dist/ .venv/__pycache__ frontend/.vite
