#!/usr/bin/env python3
"""Output-token $ by session KIND x effort over a window of the extract.py ledger.

The per-kind effort policy (server/src/agents/effort.ts, ^busy-elk 2026-10-01) runs ticket
forks / cron + listener --fork wakes / agent-chat forks at `high` and everything else at
`xhigh`. This is the before/after check: run it on the 22-28 Sep baseline and again on the
first full week after the hub restart that activated the policy.

Kind is inferred per session from its wake envelopes in the window (the hub's own words):
  fork          [BOARD TASK ...] IDENTITY: YOU are the dedicated fork      (ticket-fork)
  cronFork      [CRON FORK] ...
  listenerFork  [LISTENER FORK] ...
  chatFork      [Forked side-conversation ...]                              (con agent chat)
  default       anything else (generals, Al, SPA forks, terminal sessions)

Usage: python3 effort.py LEDGER.jsonl [FROM] [TO]      (dates YYYY-MM-DD local, TO exclusive)
"""
import json, sys, collections, datetime

LEDGER = sys.argv[1]
def _day(s): return datetime.datetime.fromisoformat(s).timestamp()
CUT = _day(sys.argv[2]) if len(sys.argv) > 2 else 0
END = _day(sys.argv[3]) if len(sys.argv) > 3 else 1e18

KIND_MARKS = (('[CRON FORK]', 'cronFork'), ('[LISTENER FORK]', 'listenerFork'),
              ('[Forked side-conversation', 'chatFork'), ('IDENTITY: YOU are the dedicated fork', 'fork'))

kind = {}
reqs = []
for line in open(LEDGER):
    r = json.loads(line)
    if r['ts'] < CUT or r['ts'] >= END: continue
    if r['k'] == 'wake':
        h = r.get('head') or ''
        for mark, k in KIND_MARKS:
            if mark in h:
                kind.setdefault(r['sid'], k)
                break
    elif r['k'] == 'req' and not r.get('side'):
        reqs.append(r)

by = collections.defaultdict(lambda: {'req': 0, 'out': 0, 'usd_out': 0.0, 'usd': 0.0, 'sids': set()})
for r in reqs:
    k = kind.get(r['sid'], 'default')
    b = by[(k, r.get('effort') or '?')]
    b['req'] += 1; b['out'] += r['out']; b['usd_out'] += r['usd_out']; b['usd'] += r['usd']; b['sids'].add(r['sid'])

tot_out = sum(b['usd_out'] for b in by.values()) or 1
tot_req = sum(b['req'] for b in by.values()) or 1
days = max(1, (min(END, max(r['ts'] for r in reqs)) - max(CUT, min(r['ts'] for r in reqs))) / 86400) if reqs else 1
print(f"{len(reqs):,} requests over {days:.1f} days  (non-sidechain; $ at Bedrock list rates as extract.py computes them)")
print(f"{'kind':<13}{'effort':<8}{'sessions':>9}{'requests':>10}{'req%':>6}{'out tok':>12}{'out $':>9}{'out$/wk':>9}{'out%':>6}{'all $':>9}")
for (k, e), b in sorted(by.items(), key=lambda kv: -kv[1]['usd_out']):
    print(f"{k:<13}{e:<8}{len(b['sids']):>9,}{b['req']:>10,}{b['req']/tot_req*100:>5.0f}%{b['out']:>12,}{b['usd_out']:>9,.0f}{b['usd_out']/days*7:>9,.0f}{b['usd_out']/tot_out*100:>5.0f}%{b['usd']:>9,.0f}")
print()
agg = collections.defaultdict(lambda: {'req': 0, 'usd_out': 0.0})
for (k, e), b in by.items():
    agg[k]['req'] += b['req']; agg[k]['usd_out'] += b['usd_out']
print('per kind:  ' + '   '.join(f"{k} ${a['usd_out']/days*7:,.0f}/wk ({a['req']:,} req)" for k, a in sorted(agg.items(), key=lambda kv: -kv[1]['usd_out'])))
print(f"total output $/wk: {tot_out/days*7:,.0f}")
