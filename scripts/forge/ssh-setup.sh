#!/usr/bin/env bash
# Install the `Host forge` block in ~/.ssh/config. Idempotent: the block is
# delimited by markers and rewritten in place, so re-running after a re-provision
# picks up a new instance id without duplicating anything.
set -euo pipefail

CRED="${FORGE_CRED_FILE:-$HOME/.config/console/forge.json}"
CFG="$HOME/.ssh/config"
BEGIN="# >>> console forge (managed by scripts/forge/ssh-setup.sh) >>>"
END="# <<< console forge <<<"
# Resolve against the MAIN checkout, not a worktree: ssh config outlives this branch.
PROXY="${FORGE_PROXY:-$HOME/proj/code/console/scripts/forge/ssm-proxy.sh}"

[ -f "$CRED" ] || { echo "no $CRED — run scripts/forge/provision.sh first" >&2; exit 1; }
read -r INSTANCE KEYFILE USER_ <<<"$(python3 - "$CRED" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print(d["instanceId"], d.get("sshKey", "~/.ssh/forge_ed25519"), d.get("remoteUser", "ubuntu"))
PY
)"

install -d -m 0700 "$HOME/.ssh"
touch "$CFG"
python3 - "$CFG" "$BEGIN" "$END" <<'PY'
import sys
path, begin, end = sys.argv[1:4]
lines = open(path).read().split("\n")
out, skip = [], False
for ln in lines:
    if ln.strip() == begin: skip = True; continue
    if ln.strip() == end: skip = False; continue
    if not skip: out.append(ln)
open(path, "w").write("\n".join(out).rstrip("\n") + "\n")
PY

cat >> "$CFG" <<EOF
$BEGIN
Host forge
  HostName $INSTANCE
  User $USER_
  IdentityFile $KEYFILE
  IdentitiesOnly yes
  ProxyCommand $PROXY %h %p
  # One multiplexed connection per box: the hub adds per-session port forwards
  # to it with \`ssh -O forward\` instead of reconnecting.
  ControlMaster auto
  ControlPath $HOME/.ssh/cm-forge-%r
  ControlPersist 10m
  ServerAliveInterval 30
  ServerAliveCountMax 4
  StrictHostKeyChecking accept-new
  # SSM's transport is a websocket; keep SSH from giving up during a cold boot.
  ConnectTimeout 30
$END
EOF
chmod 600 "$CFG"
echo "wrote Host forge -> $INSTANCE (via SSM, no inbound ports)"
echo "test: ssh forge 'hostname; nproc; free -g | head -2'"
