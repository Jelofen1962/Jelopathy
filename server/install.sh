#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
PYTHON_BIN="${PYTHON_BIN:-python3}"
command -v "$PYTHON_BIN" >/dev/null 2>&1 || { echo "Python 3.10+ is required." >&2; exit 1; }
"$PYTHON_BIN" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 1)' || { echo "Python 3.10+ is required." >&2; exit 1; }
if [[ ! -d .venv ]]; then "$PYTHON_BIN" -m venv .venv; fi
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements.txt
if [[ ! -f .env ]] || ! grep -qE '^JELOPATHY_SERVER_TOKEN=.{20,}$' .env || grep -q 'replace-with-a-long-random-secret' .env; then
  TOKEN="$(.venv/bin/python -c 'import secrets; print(secrets.token_urlsafe(36))')"
  if [[ -f .env ]]; then
    if grep -q '^JELOPATHY_SERVER_TOKEN=' .env; then
      sed -i "s|^JELOPATHY_SERVER_TOKEN=.*|JELOPATHY_SERVER_TOKEN=$TOKEN|" .env
    else
      printf '\nJELOPATHY_SERVER_TOKEN=%s\n' "$TOKEN" >> .env
    fi
  else
    printf 'JELOPATHY_SERVER_TOKEN=%s\nJELOPATHY_HOST=0.0.0.0\nJELOPATHY_PORT=8080\n' "$TOKEN" > .env
  fi
  chmod 600 .env 2>/dev/null || true
  echo "Generated a strong server token in server/.env (keep it secret)."
fi
set -a
# shellcheck disable=SC1091
source .env
set +a
printf '\nJelopathy relay is starting. Configure the desktop app with:\n  Server URL: http://YOUR_SERVER_IP:%s\n  Access token: value of JELOPATHY_SERVER_TOKEN in server/.env\n\n' "${JELOPATHY_PORT:-8080}"
exec .venv/bin/python server.py
