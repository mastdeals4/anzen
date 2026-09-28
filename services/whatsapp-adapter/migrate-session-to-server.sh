#!/usr/bin/env bash
set -e

# ==============================================================================
# Export paired WhatsApp Business session to migrate from Mac to Server
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

SESSION_NAME="sapj-business-whatsapp"
ARCHIVE_NAME="whatsapp-session-${SESSION_NAME}.tar.gz"

echo "Packaging session '$SESSION_NAME'..."

if [ ! -d "./_sessions/$SESSION_NAME" ]; then
  echo "[ERROR] Session directory ./_sessions/$SESSION_NAME does not exist."
  exit 1
fi

# Clean lock files before archiving
for lock in SingletonLock SingletonCookie SingletonSocket; do
  rm -f "./_sessions/$SESSION_NAME/$lock" 2>/dev/null || true
done

tar -czf "$ARCHIVE_NAME" -C "./_sessions" "$SESSION_NAME"
echo "[SUCCESS] Created session bundle: $SCRIPT_DIR/$ARCHIVE_NAME ($(du -h "$ARCHIVE_NAME" | cut -f1))"
echo ""
echo "To restore on your server:"
echo "  scp $SCRIPT_DIR/$ARCHIVE_NAME user@your-server:/path/to/services/whatsapp-adapter/"
echo "  ssh user@your-server 'cd /path/to/services/whatsapp-adapter && tar -xzf $ARCHIVE_NAME -C ./_sessions'"
