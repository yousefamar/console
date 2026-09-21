"""Simulate prompt-cache TTL x hibernation-threshold policies over real traces.

Ground truth from a 14d warm/cold audit (2026-09-21): a `--resume` respawn is
NOT byte-stable (fresh gitStatus/date in the rebuilt prompt), so a request is
warm ⟺ its gap since the previous request < min(cache TTL, hibernate threshold).
  prev-TTL 1h, gap 5-30m (process alive):   2% cold
  prev-TTL 1h, gap 35-60m (hibernated):    80% cold  ← resume rewrites
  prev-TTL 5m, gap 5-30m:                  95% cold  ← TTL lapse
Policies simulated per request: cold ⇒ whole context written at the TTL's write
rate; warm ⇒ context read + observed suffix write. Output priced identically
everywhere so deltas are pure input-side. Requests cold at gap<5m are
cache-invalidating edits — cold under every policy.
"""
import json, glob, os, time, collections, datetime, statistics

CUT = time.time() - 7 * 86400
files = [f for f in glob.glob(os.path.expanduser('~/.claude/projects/*/*.jsonl')) if os.path.getmtime(f) > CUT]

RATES = {  # $/MTok: (base, read, w5m, w1h, out)
    'fable-5-1': (10, 0.25, 12.5, 20, 50),
    'fable-5':   (10, 1.00, 12.5, 20, 50),
    'opus':      (5,  0.50, 6.25, 10, 25),
    'sonnet-4':  (3,  0.30, 3.75, 6,  15),
    'sonnet':    (2,  0.20, 2.5,  4,  10),
    'haiku':     (1,  0.10, 1.25, 2,  5),
}
def rate(model):
    for k, v in RATES.items():
        if k in (model or ''): return v
    return RATES['fable-5-1']

def parse(ts):
    try: return datetime.datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp()
    except Exception: return None

try:
    manifest = json.load(open(os.path.expanduser('~/.claude/console-hub-sessions.json')))
    hub_ids = {e['claudeSessionId'] for e in manifest}
except Exception:
    hub_ids = set()
def is_hub(path):
    return os.path.basename(path).replace('.jsonl', '') in hub_ids \
        or '-home-amar-sync-brain-' in path

# (label, ttl_seconds, hibernate_seconds). Warm window = min(ttl, hib + 300 sweep slop).
POLICIES = [
    ('all-5m, hib 30m (pre-TTL-work baseline)', 300, 1800),
    ('all-1h, hib 30m (TTL fix alone — hibernation still eats 35-60m)', 3600, 1800),
    ('all-1h, hib 65m (proposal)', 3600, 3900),
]

seen = set()
sessions = []   # (is_hub, [(gap, ctx, warm_obs, cw_obs, rates)])
for f in files:
    reqs = []; last = None
    with open(f) as fh:
        for line in fh:
            try: j = json.loads(line)
            except Exception: continue
            m = j.get('message') or {}
            if m.get('role') != 'assistant': continue
            u = m.get('usage')
            if not u: continue
            mid = m.get('id'); ts = parse(j.get('timestamp') or '')
            if not ts or ts < CUT: continue
            if mid:
                if mid in seen:
                    last = ts; continue
                seen.add(mid)
            cr = u.get('cache_read_input_tokens', 0) or 0
            cw = u.get('cache_creation_input_tokens', 0) or 0
            gap = (ts - last) if last else None
            last = ts
            reqs.append((gap, cr + cw, cw / max(cr + cw, 1) <= 0.5, cw, rate(m.get('model'))))
    if reqs: sessions.append((is_hub(f), reqs))

suffix = statistics.median([cw for _, rs in sessions for _, _, warm, cw, _ in rs if warm and cw > 0] or [8000])

print(f'{sum(len(r) for _, r in sessions):,} requests / {len(sessions)} sessions; median warm suffix write {suffix/1000:.0f}k tokens')
print(f'{"policy":68s} {"hub $/wk":>9s} {"term $/wk":>10s} {"total":>8s}')
# Current reality: price observed classes (approx: observed warm/cold as-is, 1h writes where pinned —
# reuse the cold-vs-warm pricing by pricing observed cw at its actual ephemeral split is done there;
# here price observed cold at w5m/w1h mix ≈ actual using warm flag + per-req rates is close enough
for label, ttl, hib in POLICIES:
    window = min(ttl, hib + 300)
    wrate_i = 3 if ttl >= 3600 else 2   # index into rates tuple
    tot = {True: 0.0, False: 0.0}
    for hub, reqs in sessions:
        c = 0.0
        for gap, ctx, warm_obs, cw_obs, r in reqs:
            invalidating = warm_obs is False and gap is not None and gap < 300
            warm = gap is not None and gap < window and not invalidating
            if warm:
                c += ctx * r[1] / 1e6 + (cw_obs if warm_obs else suffix) * r[wrate_i] / 1e6
            else:
                c += ctx * r[wrate_i] / 1e6
        tot[hub] += c
    print(f'{label:68s} {tot[True]:9,.0f} {tot[False]:10,.0f} {tot[True]+tot[False]:8,.0f}')
