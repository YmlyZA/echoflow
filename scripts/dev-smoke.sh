#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-$(node --input-type=module <<'NODE'
import net from "node:net";

const server = net.createServer();
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    process.exit(1);
  }
  console.log(address.port);
  server.close();
});
NODE
)}"
API_KEY="${ECHOFLOW_API_KEY:-dev-key}"
BACKEND_LOG="${TMPDIR:-/tmp}/echoflow-dev-smoke-backend.log"

cleanup() {
  if [[ -n "${BACKEND_PID:-}" ]] && kill -0 "${BACKEND_PID}" 2>/dev/null; then
    kill "${BACKEND_PID}" 2>/dev/null || true
    wait "${BACKEND_PID}" 2>/dev/null || true
  fi
}

trap cleanup EXIT

cd "${ROOT_DIR}"

PORT="${PORT}" ECHOFLOW_API_KEY="${API_KEY}" pnpm --filter @echoflow/backend dev \
  >"${BACKEND_LOG}" 2>&1 &
BACKEND_PID="$!"

node --input-type=module <<NODE
const deadline = Date.now() + 15_000;
const url = "http://127.0.0.1:${PORT}/healthz";

while (Date.now() < deadline) {
  try {
    const response = await fetch(url);
    if (response.ok) {
      process.exit(0);
    }
  } catch {
    // Backend is still starting.
  }

  await new Promise((resolve) => setTimeout(resolve, 250));
}

console.error("Backend did not become healthy. Log: ${BACKEND_LOG}");
process.exit(1);
NODE

ECHOFLOW_E2E_SERVER_URL="http://127.0.0.1:${PORT}" \
  ECHOFLOW_E2E_API_KEY="${API_KEY}" \
  pnpm --filter @echoflow/extension test:e2e
