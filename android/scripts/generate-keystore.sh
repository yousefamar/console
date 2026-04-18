#!/usr/bin/env bash
# Generate the release keystore for signing the Console APK.
#
# Run once, then back up the file — losing it means the installed APK can
# never be upgraded (Android enforces same-signer upgrades).
set -euo pipefail

KEYSTORE_DIR="${HOME}/.config/console"
KEYSTORE_PATH="${KEYSTORE_DIR}/console-release.jks"

mkdir -p "${KEYSTORE_DIR}"

if [ -f "${KEYSTORE_PATH}" ]; then
  echo "Keystore already exists: ${KEYSTORE_PATH}" >&2
  echo "Refusing to overwrite. Remove it manually if you really want a new one." >&2
  exit 1
fi

echo "Generating release keystore at ${KEYSTORE_PATH}"
echo "You will be prompted for a store password, key password, and certificate details."
echo "Suggested: same password for both, distinguishing name = 'CN=Console, O=amar.io'"

keytool -genkeypair -v \
  -keystore "${KEYSTORE_PATH}" \
  -keyalg RSA -keysize 4096 -validity 36500 \
  -alias console

chmod 600 "${KEYSTORE_PATH}"
echo
echo "Keystore written to ${KEYSTORE_PATH}"
echo "Back this file up! Losing it means no future updates."
echo
echo "Export these env vars when running ./gradlew assembleRelease:"
echo "  export CONSOLE_KEYSTORE_PATH=${KEYSTORE_PATH}"
echo "  export CONSOLE_KEYSTORE_PASSWORD=<store password>"
echo "  export CONSOLE_KEY_ALIAS=console"
echo "  export CONSOLE_KEY_PASSWORD=<key password>"
