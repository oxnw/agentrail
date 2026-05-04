#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <package.whl>" >&2
  exit 1
fi

PACKAGE_PATH="$1"
PYTHON_BIN="${PYTHON_BIN:-}"
if [ -z "$PYTHON_BIN" ]; then
  for candidate in python3.12 python3.11 python3.10 python3 python; do
    if command -v "$candidate" >/dev/null 2>&1; then
      PYTHON_BIN="$(command -v "$candidate")"
      break
    fi
  done
  if [ -z "$PYTHON_BIN" ]; then
    echo "python3.10+ is required" >&2
    exit 1
  fi
fi

"$PYTHON_BIN" - <<'PY'
import sys

if sys.version_info < (3, 10):
    raise SystemExit("python3.10+ is required")
PY

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/agentrail-py-sdk-XXXXXX")"
trap 'rm -rf "$WORKDIR"' EXIT

"$PYTHON_BIN" -m venv "$WORKDIR/.venv"
"$WORKDIR/.venv/bin/pip" install --quiet "$PACKAGE_PATH"

"$WORKDIR/.venv/bin/python" - <<'PY'
import asyncio

from agentrail import AgentRailClient, DEFAULT_BASE_URL


async def main() -> None:
    client = AgentRailClient(api_key="smoke-test-key")
    if DEFAULT_BASE_URL != "http://127.0.0.1:3000":
        raise RuntimeError("Default base URL mismatch")
    await client.close()
    print("Python SDK smoke test passed.")


asyncio.run(main())
PY
