#!/bin/sh
set -e

echo "[entrypoint] Checking binaries..."
if [ -n "$CHROMIUM_PATH" ] && command -v "$CHROMIUM_PATH" >/dev/null 2>&1; then
  echo "[entrypoint] Chromium: $($CHROMIUM_PATH --version 2>/dev/null || echo 'unknown')"
else
  echo "[entrypoint] Chromium not found at $CHROMIUM_PATH"
  echo "[entrypoint] Trying common locations..."
  for p in /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/chrome; do
    if command -v "$p" >/dev/null 2>&1; then
      echo "[entrypoint] Found chrome binary at $p -> $($p --version 2>/dev/null || echo 'unknown')"
      break
    fi
  done
fi

if command -v ffmpeg >/dev/null 2>&1; then
  echo "[entrypoint] ffmpeg: $(ffmpeg -version | head -n1)"
else
  echo "[entrypoint] ffmpeg not found"
fi

# NOTE: ownership of /data and /session must be set by the operator before running the container.
exec "$@"
