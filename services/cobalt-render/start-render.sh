#!/bin/sh
set -eu

if [ -z "${COBALT_API_KEY:-}" ]; then
  echo "COBALT_API_KEY is required."
  exit 1
fi

api_port="${PORT:-9000}"
key_file="/tmp/cobalt-keys.json"

printf '{"%s":{"name":"chaipian-ai","limit":12}}' "${COBALT_API_KEY}" > "${key_file}"
chmod 600 "${key_file}"

export API_PORT="${api_port}"
export API_KEY_URL="file://${key_file}"
export API_AUTH_REQUIRED="1"

exec node src/cobalt
