#!/usr/bin/env python3
"""Attribute Claude Code API requests/day by wake source (request-count diet, ^cool-newt).

Reads the last N days (default 14) of ~/.claude/projects/*/*.jsonl. A "request" is a
unique assistant message.id (global dedupe — transcript-copy forks re-list their
parent's requests, so per-file counting overcounts). Every non-tool-result user
message is classified as a wake source (board dispatch, cron fire matched against
agent-cron.json prompt prefixes, listener, merge fold-in, hub-restart nudge, user, ...)
and all requests until the next wake are attributed to it. Wakes dedupe by
(timestamp, text-prefix) for the same transcript-copy reason.

Usage: python3 requests.py [days]
"""
import json, os, sys, glob, collections, datetime

DAYS = int(sys.argv[1]) if len(sys.argv) > 1 else 14
now = datetime.datetime.now(datetime.timezone.utc)
cutoff = now - datetime.timedelta(days=DAYS)
cut = cutoff.strftime('%Y-%m-%dT%H:%M:%S')

cron_prefixes = {}
cj = json.load(open(os.path.expanduser('~/.config/console/agent-cron.json')))
for t in cj.get('tasks', []):
    p = t.get('prompt', '')
    if p: cron_prefixes[p[:64]] = t.get('id', '?')

def classify(text):
    """Return (source, fine) or None to keep current source (continuation)."""
    t = text.lstrip()
    if t.startswith('[BOARD TASK'): return ('board-dispatch', 'board-dispatch')
    if t.startswith('[CARD APPROVED'): return ('board-approve', 'board-approve')
    if t.startswith('[MERGE — folding you back') or t.startswith('[MERGE - folding'):
        return ('merge-child-summary', 'merge-child-summary')
    if t.startswith('[MERGE'): return ('merge-parent-absorb', 'merge-parent-absorb')
    if t.startswith('[FORK — branched'): return ('fork-seed', 'fork-seed')
    if t.startswith('[EVENT'): return ('listener', 'listener')
    if t.startswith('[WEBHOOK'): return ('webhook', 'webhook')
    if t.startswith('[VOICE CALL'): return ('voice-call', 'voice-call')
    if t.startswith('[INBOUND WhatsApp') or t.startswith('[INBOUND '): return ('al-inbound-chat', 'al-inbound-chat')
    if t.startswith('[CONVERSATION FORK'): return ('al-conv-fork', 'al-conv-fork')
    if t.startswith('[Forked side-conversation'): return ('agent-chat', 'agent-chat')
    if t.startswith('<task-notification'): return ('task-notif', 'task-notif')
    if t.startswith('The hub was restarted, which interrupted'): return ('hub-restart-nudge', 'hub-restart-nudge')
    if t.startswith('The previous request hit a transient API error'): return ('api-retry', 'api-retry')
    if t.startswith('Base directory for this skill'): return None
    if t.startswith('<local-command') or t.startswith('<command-name'): return ('user', 'user')
    if t.startswith('This session is being continued'): return None
    if t[:64] in cron_prefixes:
        cid = cron_prefixes[t[:64]]
        return ('cron', 'cron:' + cid)
    if '--- guard output (' in t[:4000]: return ('cron', 'cron:removed-or-old')
    return ('user?', 'user?')

by_src = collections.Counter()
by_fine = collections.Counter()
by_proj_src = collections.Counter()
wakes_by_src = collections.Counter()
req_days = collections.Counter()
day_src = collections.Counter()
restart_stamps = set()
gseen_req = set()
gseen_wake = set()

files = [f for f in glob.glob(os.path.expanduser('~/.claude/projects/*/*.jsonl'))
         if datetime.datetime.fromtimestamp(os.path.getmtime(f), datetime.timezone.utc) > cutoff]

for f in files:
    proj = os.path.basename(os.path.dirname(f)).replace('-home-amar-', '').replace('sync-brain-root-projects-', '')
    src, fine = 'unknown', 'unknown'
    try: fh = open(f, errors='replace')
    except OSError: continue
    for line in fh:
        if len(line) < 20: continue
        try: d = json.loads(line)
        except Exception: continue
        typ = d.get('type'); ts = d.get('timestamp') or ''
        if typ == 'user' and not d.get('isSidechain'):
            m = d.get('message') or {}; c = m.get('content'); text = None
            if isinstance(c, str): text = c
            elif isinstance(c, list):
                parts = [b.get('text', '') for b in c if isinstance(b, dict) and b.get('type') == 'text']
                if parts: text = '\n'.join(parts)
            if text and text.strip():
                r = classify(text)
                if r is not None:
                    src, fine = r
                    wk = (ts, text[:80])
                    if ts >= cut and wk not in gseen_wake:
                        gseen_wake.add(wk)
                        wakes_by_src[src] += 1
                        if src == 'hub-restart-nudge' and ts:
                            restart_stamps.add(ts[:15])  # 10-min bucket
        elif typ == 'assistant':
            mid = (d.get('message') or {}).get('id')
            if not mid or mid in gseen_req: continue
            gseen_req.add(mid)
            if not ts or ts < cut: continue
            by_src[src] += 1; by_fine[fine] += 1
            by_proj_src[(proj, src)] += 1
            req_days[ts[:10]] += 1
            day_src[(ts[:10], src)] += 1
    fh.close()

total = sum(by_src.values())
print(f'=== requests by source, last {DAYS}d (global dedupe) — total {total} (~{total/DAYS:.0f}/day) ===')
for s, n in by_src.most_common():
    w = wakes_by_src.get(s, 0)
    print(f'{n:8d}  {n/total*100:5.1f}%  {s:22s} {w:6d} wakes  {n/max(1,w):6.1f} req/wake')

print('\n=== fine-grained (top 30) ===')
for s, n in by_fine.most_common(30): print(f'{n:8d}  {s}')

print('\n=== (project, source) top 25 ===')
for (p, s), n in by_proj_src.most_common(25): print(f'{n:8d}  {p:35s} {s}')

print(f'\n=== hub restart events (10-min buckets with mid-turn nudges): {len(restart_stamps)} ===')

print('\n=== requests/day ===')
for day in sorted(req_days): print(f'{day}  {req_days[day]:6d}')

print('\n=== weekly: last 7d vs prior 7d, by source ===')
last7 = [(now - datetime.timedelta(days=i)).strftime('%Y-%m-%d') for i in range(7)]
prior7 = [(now - datetime.timedelta(days=i)).strftime('%Y-%m-%d') for i in range(7, 14)]
srcs = sorted(by_src, key=lambda s: -by_src[s])
print(f'{"source":22s} {"prior7":>8s} {"last7":>8s}')
for s in srcs:
    a = sum(day_src.get((d, s), 0) for d in prior7)
    b = sum(day_src.get((d, s), 0) for d in last7)
    print(f'{s:22s} {a:8d} {b:8d}')
print(f'{"TOTAL":22s} {sum(day_src.get((d,s),0) for d in prior7 for s in srcs):8d} {sum(day_src.get((d,s),0) for d in last7 for s in srcs):8d}')
