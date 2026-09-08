#!/usr/bin/env python3
# What would clearing stale Bash tool results have saved last week? (^brisk-wolf, 2026-09-08)
#
# Walks every Claude Code transcript under ~/.claude/projects touched in the last 7 days and,
# per API request (assistant message with usage), estimates the Bash tool_result tokens sitting
# in context, then two clearing policies modelled on the CLI's own keep-recent microcompact:
#   A) clear at COLD points only (first request / gap > 30 min = hibernation wake) — the cache
#      prefix is rebuilt there anyway, so clearing is free;
#   B) clear on EVERY request (the REPL context_hint behaviour) — upper bound, before rebuild costs.
# Context resets at each compact_boundary (ignoring compaction over-counts Bash 2-3x).
# Token estimate = chars/3.7 (same as the spend attribution in the odd-toad analysis).
# Run: python3 scripts/context-clearing-sim.py   (~30 s, read-only, zero tokens)
import json, glob, os, time, collections
from datetime import datetime
CUT = time.time() - 7*86400
KEEP = 5                     # the CLI's own keepRecent for tool-result clearing
MARK = 10                    # tokens of "[Old tool result content cleared]"
GAP = 30*60                  # hibernation threshold (hub sweeps idle >30 min)
def tk(s): return len(s)/3.7
def result_tokens(b):
    cc = b.get('content')
    if isinstance(cc, list):
        return sum(tk(x.get('text','')) if x.get('type')=='text' else 1500 for x in cc if isinstance(x, dict))
    return tk(cc if isinstance(cc, str) else json.dumps(cc))
def ts(j):
    t = j.get('timestamp')
    if not t: return None
    try: return datetime.fromisoformat(t.replace('Z','+00:00')).timestamp()
    except Exception: return None

files = [f for f in glob.glob(os.path.expanduser('~/.claude/projects/*/*.jsonl')) if os.path.getmtime(f) > CUT]
tot = collections.Counter()
per_session = []
for f in files:
    # Walk the transcript. State: list of bash tool_result ids in order, their token sizes,
    # and which are currently "cleared" under each policy.
    id2name = {}
    bash_results = []            # [(tool_use_id, tokens)] in arrival order
    cleared_wake = set(); cleared_every = set()
    last_req_ts = None; first = True
    s = collections.Counter()
    with open(f) as fh:
        for line in fh:
            try: j = json.loads(line)
            except Exception: continue
            if j.get('type') == 'system' and j.get('subtype') == 'compact_boundary':
                bash_results = []; cleared_wake = set(); cleared_every = set(); s['compactions'] += 1
                continue
            if j.get('type') not in ('user','assistant'): continue
            if j.get('isSidechain'): continue
            m = j.get('message') or {}
            c = m.get('content')
            if j['type'] == 'assistant' and isinstance(c, list):
                for b in c:
                    if b.get('type') == 'tool_use': id2name[b.get('id')] = b.get('name')
                u = m.get('usage') or {}
                cr = u.get('cache_read_input_tokens', 0) or 0
                if cr == 0 and not (u.get('input_tokens') or 0): continue   # not a real API request
                t = ts(j)
                cold = first or (t and last_req_ts and t - last_req_ts > GAP)
                first = False; last_req_ts = t or last_req_ts
                # Policy A (wake-only): at a cold point, clear all bash results but the last KEEP.
                if cold:
                    stale = [tid for tid,_ in bash_results[:-KEEP]]
                    cleared_wake.update(stale)
                    s['cold_points'] += 1
                # Policy B (every request, the CLI's REPL behaviour): clear all but last KEEP every time.
                cleared_every.update(tid for tid,_ in bash_results[:-KEEP])
                sizes = dict(bash_results)
                bash_in_ctx = sum(sizes.values())
                saved_wake = sum(sizes[t] - MARK for t in cleared_wake if t in sizes)
                saved_every = sum(sizes[t] - MARK for t in cleared_every if t in sizes)
                s['requests'] += 1
                s['cache_read'] += cr
                s['bash_ctx_tokens'] += bash_in_ctx
                s['saved_wake'] += saved_wake
                s['saved_every'] += saved_every
            elif j['type'] == 'user' and isinstance(c, list):
                for b in c:
                    if b.get('type') == 'tool_result' and id2name.get(b.get('tool_use_id')) == 'Bash':
                        bash_results.append((b['tool_use_id'], result_tokens(b)))
    if s['requests']:
        per_session.append((os.path.basename(f)[:8], s))
        tot.update(s)

print(f"sessions={len(per_session)} requests={tot['requests']:,} cold_points={tot['cold_points']:,} compactions={tot['compactions']:,}")
print(f"actual cache_read tokens (7d):            {tot['cache_read']:>16,.0f}")
print(f"est. Bash output tokens re-read (Σ ctx):  {tot['bash_ctx_tokens']:>16,.0f}  ({tot['bash_ctx_tokens']/tot['cache_read']*100:.1f}% of cache_read)")
print(f"saved if cleared at COLD points only:     {tot['saved_wake']:>16,.0f}  ({tot['saved_wake']/tot['cache_read']*100:.1f}% of cache_read)  — zero cache-rebuild cost")
print(f"saved if cleared EVERY request (REPL MC): {tot['saved_every']:>16,.0f}  ({tot['saved_every']/tot['cache_read']*100:.1f}% of cache_read)  — before rebuild costs")
print()
print("top sessions by avoidable Bash re-read at cold points:")
for name, s in sorted(per_session, key=lambda x: -x[1]['saved_wake'])[:8]:
    print(f"  {name}  requests={s['requests']:>5}  cold={s['cold_points']:>3}  saved_wake={s['saved_wake']:>12,.0f}  bash_ctx={s['bash_ctx_tokens']:>13,.0f}  cache_read={s['cache_read']:>14,.0f}")
