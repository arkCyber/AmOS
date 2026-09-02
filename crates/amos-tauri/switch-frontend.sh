#!/usr/bin/env bash
# Point Tauri at the TS (Vite) UI or back to the legacy vanilla UI.
#   usage: switch-frontend.sh ts     -> frontendDist=frontend-ts/dist, devUrl=:1420
#          switch-frontend.sh legacy -> frontendDist=frontend, devUrl=:5173
set -euo pipefail
CFG="$(cd "$(dirname "$0")" && pwd)/tauri.conf.json"

if [ "${1:-}" = "ts" ]; then
  FE="frontend-ts/dist"; DEV="http://localhost:1420"
elif [ "${1:-}" = "legacy" ]; then
  FE="frontend"; DEV="http://localhost:5173"
else
  echo "usage: $0 ts|legacy"; exit 1
fi

python3 - "$CFG" "$FE" "$DEV" <<'PY'
import json, sys
cfg, fe, dev = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(cfg))
d["build"]["frontendDist"] = fe
d["build"]["devUrl"] = dev
with open(cfg, "w") as f:
    json.dump(d, f, ensure_ascii=False, indent=2)
    f.write("\n")
print(f"[tauri] frontendDist -> {fe} | devUrl -> {dev}")
PY
