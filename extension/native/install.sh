#!/usr/bin/env bash
# Register the local native host. Browser loading stays in the supported UI.
set -euo pipefail
dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
if [[ ! -x /usr/bin/node ]]; then
  echo 'VidCapture requires system Node.js at /usr/bin/node. Install the desktop prerequisites first.' >&2
  exit 1
fi
exec /usr/bin/node "$dir/install.cjs" "$@"
