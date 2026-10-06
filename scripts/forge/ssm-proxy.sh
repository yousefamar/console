#!/usr/bin/env bash
# ssh ProxyCommand for forge: carries the SSH stream over SSM Session Manager.
#
# Why: forge's security group has ZERO inbound rules, so there is no SSH port to
# dial. SSM gives us a transport without one, which means no public ingress, no
# Tailscale auth key, and no human click anywhere in the path. `ssh -L` / `-R`
# are SSH-level features, so they work unchanged through this.
#
# Usage (from ~/.ssh/config): ProxyCommand .../ssm-proxy.sh %h %p
# %h is the INSTANCE ID (ssh config sets HostName to it).
set -euo pipefail

CRED="${FORGE_CRED_FILE:-$HOME/.config/console/forge.json}"
TARGET="${1:?instance id}"
PORT="${2:-22}"

# The hub runs under pm2 with a minimal PATH; session-manager-plugin lives in
# ~/.local/bin (installed without root) and `aws` may be in either prefix.
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"

if [ -f "$CRED" ]; then
  eval "$(python3 - "$CRED" <<'PY'
import json, shlex, sys
d = json.load(open(sys.argv[1]))
for env, key in (("AWS_ACCESS_KEY_ID","accessKeyId"),
                 ("AWS_SECRET_ACCESS_KEY","secretAccessKey"),
                 ("AWS_REGION","region"),
                 ("AWS_DEFAULT_REGION","region")):
    if d.get(key):
        print(f"export {env}={shlex.quote(d[key])}")
PY
)"
  # The scoped hub key is self-contained; make sure no ambient profile overrides it.
  unset AWS_PROFILE
fi

exec aws ssm start-session \
  --target "$TARGET" \
  --document-name AWS-StartSSHSession \
  --parameters "portNumber=$PORT"
