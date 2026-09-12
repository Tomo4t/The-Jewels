#!/bin/sh
# Prepare the persistent volume, then drop root.
#
# Managed hosts mount volumes owned by root. The common advice is to run the
# whole application as root so it can write there; for an internet-facing app
# that accepts uploads that is a poor trade. Instead this fixes ownership while
# still privileged, then hands off to an unprivileged user.
set -e

DATA_DIR="${RAILWAY_VOLUME_MOUNT_PATH:-/data}"
mkdir -p "$DATA_DIR"

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR" 2>/dev/null || true

  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid=node --regid=node --init-groups "$@"
  fi

  # Without setpriv there is no way to drop privileges here; carry on as root
  # rather than failing the deploy, but say so in the logs.
  echo "[entrypoint] setpriv unavailable - continuing as root" >&2
fi

exec "$@"
