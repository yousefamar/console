#!/usr/bin/env bash
# Switch the whole `claude`-spawning surface (hub agents, Al, ad-hoc CLI) BACK
# to Amazon Bedrock from the first-party Max subscription.
#
# Why a script (not a prose cron prompt): the switch is TWO coordinated edits
# that must both land or agents 400 —
#   1. ~/.claude/settings.json `env` → the Bedrock backend vars (each `claude`
#      subprocess reads these at spawn; CLAUDE_CODE_USE_BEDROCK is the switch).
#   2. the hub's model chain (~/.config/console/agent-model.json) → the
#      `us.anthropic.*`-prefixed Bedrock ids, since bare first-party ids 400 on
#      Bedrock and vice-versa.
# Then a hub restart so live sessions pick up the new backend.
#
# Restores settings.json from the backup taken when we switched TO the Max sub
# (settings.json.bedrock-bak) so the exact ARNs/profile come back verbatim.
# Idempotent: safe to run more than once. Created 2026-07-09 for the Jul-26
# Max-subscription expiry.
set -euo pipefail

SETTINGS="$HOME/.claude/settings.json"
BAK="$HOME/.claude/settings.json.bedrock-bak"
MODELCFG="$HOME/.config/console/agent-model.json"
LOG="$HOME/.config/console/switch-to-bedrock.log"

log() { echo "[$(date -Is)] $*" | tee -a "$LOG"; }

log "switch-to-bedrock: starting"

# 1. Restore the Bedrock env block into settings.json (merge: keep any env keys
#    added since the backup, override with the backup's Bedrock vars).
if [ ! -f "$BAK" ]; then
  log "ERROR: backup $BAK not found — cannot restore Bedrock env. Aborting."
  exit 1
fi
python3 - "$SETTINGS" "$BAK" <<'PY'
import json, sys
cur_path, bak_path = sys.argv[1], sys.argv[2]
cur = json.load(open(cur_path))
bak = json.load(open(bak_path))
env = cur.get('env', {})
env.update(bak.get('env', {}))          # bring back CLAUDE_CODE_USE_BEDROCK, AWS_*, ANTHROPIC_MODEL, ...
cur['env'] = env
json.dump(cur, open(cur_path, 'w'), indent=2)
print('settings.json env restored to Bedrock:', sorted(k for k in env if 'BEDROCK' in k.upper() or 'AWS' in k.upper()))
PY

# 2. Swap the hub model chain to the Bedrock-prefixed ids (VERIFIED working on
#    this deployment 2026-07-06). Written directly so it survives even if the
#    hub is momentarily down; the restart below loads it.
python3 - "$MODELCFG" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d['chain'] = [
    'us.anthropic.claude-fable-5',
    'us.anthropic.claude-opus-4-8',
    'us.anthropic.claude-opus-4-7',
    'us.anthropic.claude-sonnet-5',
    'us.anthropic.claude-haiku-4-5-20251001-v1:0',
]
d['model'] = 'us.anthropic.claude-fable-5'
json.dump(d, open(p, 'w'), indent=2)
print('hub chain set to Bedrock ids; active model', d['model'])
PY

# 3. Restart the hub so live agent subprocesses re-spawn under the Bedrock env.
log "restarting hub (con hub restart)"
con hub restart >>"$LOG" 2>&1 || pm2 restart console-server --update-env >>"$LOG" 2>&1

log "switch-to-bedrock: done — verify with: con agent model get"
