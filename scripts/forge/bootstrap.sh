#!/usr/bin/env bash
# Runs ON forge (as ubuntu, which has passwordless sudo). System-level setup:
# packages, toolchains pinned to the desktop's versions, and an `amar` user
# whose paths MIRROR THE DESKTOP EXACTLY.
#
# Path parity is not cosmetic. A session's cwd is
# /home/amar/sync/brain/root/projects/<slug>, that dir contains a `repo`
# symlink to /home/amar/proj/code/<slug>, and CLAUDE.md, the dispatch envelope
# and every agent habit name those paths. Mirroring them means a remote fork
# needs no translation layer and no edited instructions — which is the whole
# point of the exercise.
#
# Per-user toolchains (rust, uv, autowt, playwright) are in bootstrap-user.sh.
set -euo pipefail

NODE_MAJOR="${FORGE_NODE_MAJOR:-22}"
CLAUDE_VERSION="${FORGE_CLAUDE_VERSION:-2.1.288}"
ANDROID_SDK="${FORGE_ANDROID_SDK:-/opt/android-sdk}"
AMAR_HOME=/home/amar
say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

say "apt packages"
sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  build-essential git curl wget jq unzip zip rsync sshfs fuse3 util-linux \
  cmake pkg-config libssl-dev ca-certificates gnupg \
  python3-pip python3-venv python3-dev \
  openjdk-21-jdk-headless libopus-dev libasound2-dev >/dev/null

say "node $NODE_MAJOR"
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" != "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash - >/dev/null
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs >/dev/null
fi

say "corepack (repos pin their package manager — astera is pnpm@10.6.2)"
sudo corepack enable >/dev/null 2>&1 || true

say "gh (remote forks merge their own PRs; the TOKEN is installed separately)"
if ! command -v gh >/dev/null; then
  sudo mkdir -p -m 755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
  sudo chmod 644 /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gh >/dev/null
fi

# The box holds credentials since 8 Oct 2026 (Yousef: "Treat the box as an
# extension of my PC, tell console to make sure the security is hardened so
# nobody gets in but us"), so a REBUILT box must come up hardened rather than
# reverting to the cloud image's defaults.
#
# The socket unit is the load-bearing half and the easy one to get wrong:
# Ubuntu 24.04 socket-activates sshd, so systemd owns the listening socket and
# `ListenAddress` in sshd_config is silently ignored — `sshd -T` will report
# loopback while `ss` still shows 0.0.0.0:22. Access arrives via SSM
# AWS-StartSSHSession, which the agent dials as localhost:22, so there is no
# reason for a public bind to exist. Recovery if this ever goes wrong is
# `aws ssm send-command`, which runs as root without sshd in the path.
say "ssh hardening (loopback-only bind, no root login)"
sudo tee /etc/ssh/sshd_config.d/99-forge-hardening.conf >/dev/null <<'EOF'
ListenAddress 127.0.0.1
ListenAddress ::1
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
X11Forwarding no
EOF
sudo mkdir -p /etc/systemd/system/ssh.socket.d
sudo tee /etc/systemd/system/ssh.socket.d/99-forge-loopback.conf >/dev/null <<'EOF'
[Socket]
ListenStream=
ListenStream=127.0.0.1:22
ListenStream=[::1]:22
EOF
sudo sshd -t && sudo systemctl daemon-reload && sudo systemctl restart ssh.socket

say "claude code $CLAUDE_VERSION"
sudo npm install -g --silent "@anthropic-ai/claude-code@$CLAUDE_VERSION" >/dev/null

say "chrome (hub passes --chrome on every agent spawn; also serves playwright)"
if ! command -v google-chrome >/dev/null; then
  wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq /tmp/chrome.deb >/dev/null
  rm -f /tmp/chrome.deb
fi

say "android sdk at $ANDROID_SDK (compileSdk 35, AGP 8.7.2, gradle via wrapper)"
if [ ! -d "$ANDROID_SDK/cmdline-tools/latest" ]; then
  sudo install -d "$ANDROID_SDK/cmdline-tools"
  wget -q -O /tmp/cmdline.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
  sudo unzip -q /tmp/cmdline.zip -d "$ANDROID_SDK/cmdline-tools"
  sudo mv "$ANDROID_SDK/cmdline-tools/cmdline-tools" "$ANDROID_SDK/cmdline-tools/latest"
  rm -f /tmp/cmdline.zip
fi

say "user amar, with the desktop's paths"
if ! id -u amar >/dev/null 2>&1; then
  sudo useradd -m -d "$AMAR_HOME" -s /bin/bash amar
  echo 'amar ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/90-amar >/dev/null
  sudo chmod 440 /etc/sudoers.d/90-amar
fi
sudo install -d -m 0700 -o amar -g amar "$AMAR_HOME/.ssh"
sudo cp /home/ubuntu/.ssh/authorized_keys "$AMAR_HOME/.ssh/authorized_keys"
sudo chown amar:amar "$AMAR_HOME/.ssh/authorized_keys"
sudo chmod 600 "$AMAR_HOME/.ssh/authorized_keys"

# The desktop's layout, so `repo` symlinks and every documented path resolve.
sudo install -d -o amar -g amar \
  "$AMAR_HOME/proj" "$AMAR_HOME/proj/code" \
  "$AMAR_HOME/sync" "$AMAR_HOME/sync/brain" "$AMAR_HOME/sync/brain/root" \
  "$AMAR_HOME/sync/brain/root/projects" \
  "$AMAR_HOME/.claude" "$AMAR_HOME/.claude/projects" \
  "$AMAR_HOME/.config" "$AMAR_HOME/.config/console" "$AMAR_HOME/.config/autowt" \
  "$AMAR_HOME/.local" "$AMAR_HOME/.local/bin"
# 0700, not the umask default. @swc/core validates its native-binding cache
# root and refuses any group- or world-writable directory in the chain without
# a sticky bit (ERR_SWC_NATIVE_CACHE), so a 0775 ~/.cache stops EVERY Next dev
# server and Playwright run on the box — found 8 Oct 2026, after a fork could
# land a PR but not take a single screenshot. The desktop's is 0700.
sudo install -d -m 0700 -o amar -g amar "$AMAR_HOME/.cache"

# Bare mirrors + shared warm caches on the box's own fast disk — the reason
# builds are quick here rather than merely elsewhere.
sudo install -d -o amar -g amar /srv/git /srv/cache \
  /srv/cache/npm /srv/cache/gradle /srv/cache/cargo /srv/cache/uv

say "sdk ownership + licences"
sudo chown -R amar:amar "$ANDROID_SDK"
sudo -u amar bash -lc "yes 2>/dev/null | $ANDROID_SDK/cmdline-tools/latest/bin/sdkmanager --licenses >/dev/null 2>&1 || true"
sudo -u amar bash -lc "$ANDROID_SDK/cmdline-tools/latest/bin/sdkmanager --install 'platform-tools' 'platforms;android-35' 'build-tools;35.0.0' >/dev/null"

say "/etc/profile.d/forge.sh"
sudo tee /etc/profile.d/forge.sh >/dev/null <<EOF
# Managed by scripts/forge/bootstrap.sh
export ANDROID_SDK_ROOT=$ANDROID_SDK
export ANDROID_HOME=$ANDROID_SDK
export PATH="\$PATH:$ANDROID_SDK/platform-tools:$ANDROID_SDK/cmdline-tools/latest/bin:\$HOME/.cargo/bin:\$HOME/.local/bin"
export npm_config_cache=/srv/cache/npm
export GRADLE_USER_HOME=/srv/cache/gradle
export CARGO_HOME=/srv/cache/cargo
export UV_CACHE_DIR=/srv/cache/uv
# Daemon off for the same reason as the desktop (a daemon held 3.6 GB there);
# the heap can be bigger here because the box has 64 GiB and no browser.
export GRADLE_OPTS="-Dorg.gradle.daemon=false -Dorg.gradle.jvmargs=-Xmx8192m"
# Anything a fork creates on the box is private by default. Ubuntu's 022 gives
# 0644, and forks legitimately write files holding secrets: astera's
# worktree-db.sh seeds each card worktree's own .env from the shared one, and
# that landed at 0664 — credentials in a checkout, readable by the box's other
# login. The home sweep above fixes what provisioning left behind; this stops
# new files arriving the same way, which is the same instance-vs-class choice.
# Belt and braces only: this file is read by LOGIN shells, and the real control
# is the PAM block below. Agent spawns do source it (remoteCommandArgv
# dot-sources it explicitly), but they are not the only writers.
umask 077
EOF

say "umask 077 for NON-login sessions too (the real control is PAM, not profile.d)"
# /etc/profile.d is read by login shells only, so the profile.d line above left
# every path that runs a bare `ssh host command` at Ubuntu's 0002 — which is
# most of the writers that matter: forgeExec, forgePut (scp), forgeGet (rsync)
# and any ad-hoc ssh an agent types. Those are what create repos, worktrees and
# mounts. Measured on the box 8 Oct 2026: `ssh forge "bash -lc umask"` gave
# 0077 while `ssh forge umask` gave 0002 and files came out 0664 (found by
# Homelab). The agent spawn path itself was never exposed, but the class was.
#
# Two traps, both of which produce a wrong-but-plausible result:
#   - `pam_umask.so` with NO arguments silently defers to login.defs UMASK,
#     which is 022 — so the line looks present and does nothing.
#   - `umask=077` ALONE still yields 0007 (mode 660), because
#     USERGROUPS_ENAB yes makes pam_umask copy the owner bits onto the group
#     bits for a user with a private group. `nousergroups` is what pins it.
# Verify with `ssh -o ControlPath=none forge umask`: a channel multiplexed over
# an existing master inherits that master's umask and never re-runs PAM, so a
# check through a live ControlMaster reports the OLD value.
for f in /etc/pam.d/common-session /etc/pam.d/common-session-noninteractive; do
  want='session optional			pam_umask.so umask=077 nousergroups'
  if grep -q '^session.*pam_umask\.so' "$f"; then
    sudo cp -n "$f" "$f.bak-umask"
    sudo sed -i "s|^session.*pam_umask\.so.*|$want|" "$f"
  else
    echo "$want" | sudo tee -a "$f" >/dev/null
  fi
done

say "mode parity with the desktop — no group- or world-writable paths in the home"
# This is a BUG CLASS, not tidying. Provisioning steps that ran with a lax
# umask left ~/.cache at 0775 and ~/.local/{share,state} at 0775 where the
# desktop has 0700, and a group-writable cache root is silently fatal: @swc/core
# refuses it, so every dev server and Playwright run on the box died
# (ERR_SWC_NATIVE_CACHE, 8 Oct 2026). Anything else created the same way fails
# the same silent-and-total way, which is why this sweeps rather than naming
# the two directories that happened to bite.
#   -xdev   never follow into the sshfs mounts of the desktop — those files are
#           the DESKTOP'S and must not be re-moded from here.
#   ! -type l  a symlink's own mode is a meaningless constant 0777 on Linux
#           (the target governs), so including them makes the audit report
#           thousands of false positives. Found exactly that way.
sudo -u amar install -d -m 0700 "$AMAR_HOME/.local/share" "$AMAR_HOME/.local/state"
sudo -u amar chmod 0700 "$AMAR_HOME/.local/share" "$AMAR_HOME/.local/state"
sudo -u amar find "$AMAR_HOME" -xdev ! -type l \( -perm -0020 -o -perm -0002 \) \
  -exec chmod g-w,o-w {} + || say "WARNING: some paths refused the mode fix — read the errors, do not assume ownership"

say "allow sshfs mounts for non-root (forge mounts the vault back off the desktop)"
sudo sed -i 's/^#user_allow_other/user_allow_other/' /etc/fuse.conf 2>/dev/null || true

say "system bootstrap done"
node -v; claude --version | head -1; java -version 2>&1 | head -1; google-chrome --version
echo "next: bootstrap-user.sh as amar"
