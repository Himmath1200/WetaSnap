#!/usr/bin/env bash
# WeTa Snap local card reader (macOS / Linux / Git Bash).
set -euo pipefail
cd "$(dirname "$0")"

# Load .env, if there is one. Quote any value containing spaces.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

OCR_HOST="${OCR_HOST:-0.0.0.0}"
OCR_PORT="${OCR_PORT:-8099}"

PY=python3
command -v "$PY" >/dev/null 2>&1 || PY=python
[ -x .venv/bin/python ] && PY=.venv/bin/python

if ! "$PY" -c "import fastapi, uvicorn" >/dev/null 2>&1; then
  echo "Installing the service requirements..."
  "$PY" -m pip install -r requirements.txt
fi

echo
echo "  WeTa Snap card reader on http://${OCR_HOST}:${OCR_PORT}"
echo "  Check it with: http://localhost:${OCR_PORT}/health"
echo "  From a phone on the same Wi-Fi, use this machine's IP address."
echo

exec "$PY" -m uvicorn main:app --host "$OCR_HOST" --port "$OCR_PORT"
