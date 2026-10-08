#!/usr/bin/env bash
# Install a GitHub token on forge so remote forks can merge their own PRs.
#
# Why this is a script and not a line in a runbook: the token is the one
# credential the hub deliberately does NOT auto-sync. It lives in the desktop's
# keyring, so re-pushing it on every prepare would reinstall a token Yousef had
# revoked. That makes installing it a conscious act — and a conscious act that
# happens rarely is exactly the kind that gets done wrong at 2am.
#
# Usage:
#   scripts/forge/install-gh-token.sh                 # take the desktop's gh token
#   pb paste | scripts/forge/install-gh-token.sh -    # take a token on stdin
#
# Prefer `-` with a FINE-GRAINED token limited to the astera repo (contents +
# pull-requests: write, nothing else). The desktop's keyring token is a `gho_`
# with admin:org, delete_repo and repo across EVERY repo Yousef owns, which is
# far more than merging a PR in one of them needs.
#
# The token is never echoed, never written to a temp file on the desktop, and
# never passed as an argv (which `ps` would expose). It goes down the ssh pipe
# on stdin and is written straight to a 0600 file.
set -euo pipefail

HOST="${FORGE_SSH_HOST:-forge}"
GH_USER="${FORGE_GH_USER:-yousefamar}"

if [ "${1:-}" = "-" ]; then
  src="stdin"
  get_token() { cat; }
else
  src="the desktop's gh keyring"
  command -v gh >/dev/null || { echo "gh is not installed here; pass a token on stdin with '-'" >&2; exit 1; }
  get_token() { gh auth token; }
fi

echo "Installing a GitHub token on ${HOST} from ${src}..."

get_token | ssh -T -o BatchMode=yes "$HOST" '
  set -eu
  umask 077
  mkdir -p ~/.config/gh
  IFS= read -r TOKEN
  [ -n "$TOKEN" ] || { echo "no token arrived on stdin" >&2; exit 1; }
  printf "github.com:\n    user: '"$GH_USER"'\n    oauth_token: %s\n    git_protocol: https\n" "$TOKEN" > ~/.config/gh/hosts.yml
  chmod 600 ~/.config/gh/hosts.yml
  unset TOKEN
  command -v gh >/dev/null || { echo "WROTE the token, but gh is NOT installed on the box (bootstrap.sh installs it)"; exit 0; }
  # Prove the token actually works from the box rather than trusting the write.
  login=$(gh api user --jq .login 2>&1) || { echo "token written but REJECTED by the API: $login" >&2; exit 1; }
  echo "ok: authenticated as $login"
  echo "scopes: $(gh auth status 2>&1 | sed -nE "s/.*Token scopes: (.*)/\1/p")"
'
