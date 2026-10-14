#!/usr/bin/env bash
# Generates a self-signed TLS certificate for the Compose PostgreSQL service
# (PDF §A10.3 "Configure PostgreSQL with SSL for client connections").
# Output: .local/certs/pg-server.{crt,key} (git-ignored). The app verifies the
# server with DATABASE_SSL_CA_FILE pointing at the same certificate.
# Development only — use a CA-issued certificate in production.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/.local/certs"
mkdir -p "$OUT"
# Never replace an existing certificate silently (running containers and clients trust it).
if [[ -e "$OUT/pg-server.crt" || -e "$OUT/pg-server.key" ]] && [[ "${FORCE:-}" != 1 ]]; then
  echo "certificate already exists in $OUT (FORCE=1 to regenerate)"
  exit 0
fi
openssl req -new -x509 -days 365 -nodes -newkey rsa:2048 \
  -subj "/CN=postgres" -addext "subjectAltName=DNS:postgres,DNS:localhost" \
  -keyout "$OUT/pg-server.key" -out "$OUT/pg-server.crt" 2>/dev/null
chmod 600 "$OUT/pg-server.key"
echo "wrote $OUT/pg-server.crt and pg-server.key"
