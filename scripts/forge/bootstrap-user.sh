#!/usr/bin/env bash
# Runs ON forge as `amar` — the per-user half of the toolchain, plus the key
# that lets forge mount the vault back off the desktop.
set -euo pipefail
say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
[ "$(id -un)" = "amar" ] || { echo "run as amar" >&2; exit 2; }

say "rust nightly (voice/wa-voice)"
if [ ! -d "$HOME/.rustup" ]; then
  curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain nightly --profile minimal >/dev/null
fi
# shellcheck disable=SC1091
. "$HOME/.cargo/env"; rustc --version

say "uv (voice pipeline)"
command -v uv >/dev/null 2>&1 || curl -fsSL https://astral.sh/uv/install.sh | sh >/dev/null

say "autowt — remote forks create their own worktrees, exactly as on the desktop"
pip install --quiet --break-system-packages autowt >/dev/null 2>&1 || pip install --quiet autowt
# Same pattern as the desktop so worktree paths match: ../<repo>-worktrees/<branch>
cat > "$HOME/.config/autowt/config.toml" <<'EOF'
[terminal]
mode = "echo"

[worktree]
directory_pattern = "../{repo_name}-worktrees/{branch}"
auto_fetch = false

[confirmations]
cleanup_multiple = true
force_operations = true
EOF

say "playwright chromium"
npx --yes playwright@latest install chromium >/dev/null 2>&1 || true

say "key for mounting the desktop's vault (sshfs over the hub's reverse tunnel)"
if [ ! -f "$HOME/.ssh/desktop_ed25519" ]; then
  ssh-keygen -t ed25519 -N '' -C 'forge->desktop (sftp only)' -f "$HOME/.ssh/desktop_ed25519" >/dev/null
fi
echo "--- add this to the DESKTOP's ~/.ssh/authorized_keys, sftp-restricted:"
echo "restrict,command=\"internal-sftp\" $(cat "$HOME/.ssh/desktop_ed25519.pub")"

say "user bootstrap done"
