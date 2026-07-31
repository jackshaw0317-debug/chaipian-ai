#!/bin/sh
set -eu

if [ -z "${COBALT_API_KEY:-}" ] && [ -z "${API_KEY_URL:-}" ]; then
  echo "COBALT_API_KEY or API_KEY_URL is required."
  exit 1
fi

public_port="${PORT:-9000}"
internal_port="${COBALT_INTERNAL_PORT:-9001}"

if [ -n "${COBALT_API_KEY:-}" ]; then
  # Cobalt validates API keys as UUIDv4 values. Keep the external key opaque so
  # existing site deployments do not need to change, and derive a valid,
  # internal-only UUID for the loopback Cobalt process.
  export COBALT_INTERNAL_API_KEY="$(
    node -e 'const { createHash } = require("node:crypto"); const hex = createHash("sha256").update(process.env.COBALT_API_KEY).digest("hex"); const variant = "89ab"[parseInt(hex[16], 16) & 3]; console.log(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`);'
  )"
  key_file="/tmp/cobalt-keys.json"
  printf '{"%s":{"name":"chaipian-ai","limit":12}}' "${COBALT_INTERNAL_API_KEY}" > "${key_file}"
  chmod 600 "${key_file}"
  export API_KEY_URL="file://${key_file}"
fi

export API_AUTH_REQUIRED="1"
export API_PORT="${internal_port}"
export COBALT_INTERNAL_URL="http://127.0.0.1:${internal_port}"
export PROXY_PORT="${public_port}"
if [ -z "${CHROMIUM_EXECUTABLE:-}" ]; then
  CHROMIUM_EXECUTABLE="$(command -v chromium-browser || command -v chromium)"
  export CHROMIUM_EXECUTABLE
fi

node src/cobalt &
cobalt_pid=$!

cleanup() {
  kill "${cobalt_pid}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

exec node /usr/local/lib/chaipian/proxy.mjs
