#!/usr/bin/env python3
"""Report on the context proxy's ledger (~/.config/console/context-proxy.jsonl).

Per session and mode: requests, what the API cleared, how the trigger steering
behaved (hold reuse vs re-clear, backoffs, forced clears), errors, and the $ the
requests cost at Bedrock list rates versus what the SAME requests would have cost
with nothing cleared (stock = cleared tokens added back as reads on warm calls and
as writes on cold ones — the counterfactual the A/B in card ^plum-fawn reports).

Usage: python3 proxy-ledger.py [--since 7d|2026-10-02] [--session NAME] [--ledger PATH]
"""
import json, os, sys, time, datetime, collections, argparse

ap = argparse.ArgumentParser()
ap.add_argument('--since', default='7d')
ap.add_argument('--session')
ap.add_argument('--ledger', default=os.path.expanduser('~/.config/console/context-proxy.jsonl'))
A = ap.parse_args()

if A.since.endswith('d'): CUT = time.time() - int(A.since[:-1]) * 86400
elif A.since.endswith('h'): CUT = time.time() - int(A.since[:-1]) * 3600
else: CUT = datetime.datetime.fromisoformat(A.since).timestamp()

# LIST price, Bedrock bills 1.10x. No 'opus-4' row on purpose — Opus 4.8 bills the same as
# Opus 5; the old (15, 1.50, 18.75, 30, 75) row was 3x too high. Evidence: extract.py RATES.
RATES = {  # $/MTok: (base_input, read, write_5m, write_1h, output)
    'fable-5-1': (10, 0.25, 12.5, 20, 50), 'fable-5': (10, 1.00, 12.5, 20, 50),
    'opus-5-5': (4, 0.20, 5, 8, 20), 'opus': (5, 0.50, 6.25, 10, 25),
    'sonnet-4': (3, 0.30, 3.75, 6, 15), 'sonnet': (2, 0.20, 2.5, 4, 10),
    'haiku': (1, 0.10, 1.25, 2, 5),
}
def rate(model):
    m = (model or '').lower()
    for k, v in RATES.items():
        if k in m: return v
    return RATES['fable-5-1']

S = collections.defaultdict(lambda: collections.Counter())
WARM_WRITE = 4_000   # tokens a warm stock request writes (its new turn); fleet log-mode median is 0.3–5k
first_seen = {}
try:
    fh = open(A.ledger)
except OSError:
    sys.exit(f'no ledger at {A.ledger} — the proxy has not served a request yet')
for line in fh:
    try: r = json.loads(line)
    except Exception: continue
    ts = datetime.datetime.fromisoformat(r['ts'].replace('Z', '+00:00')).timestamp()
    if ts < CUT: continue
    sess = r.get('session', '?')
    if A.session and A.session not in sess: continue
    key = (sess, r.get('mode', '?'))
    s = S[key]
    s['req'] += 1
    first_seen.setdefault(key, r['ts'][:16])
    if r.get('error'): s['proxy_errors'] += 1
    u = r.get('usage') or {}
    if u.get('exception') or (r.get('status') or 0) >= 400: s['api_errors'] += 1; continue
    if not u: continue
    rd, wr, inp, out = u.get('cacheRead', 0) or 0, u.get('cacheWrite', 0) or 0, u.get('input', 0) or 0, u.get('output', 0) or 0
    w1 = u.get('cacheWrite1h'); w5 = u.get('cacheWrite5m')
    if w1 is None and w5 is None: w1, w5 = wr, 0
    base, r_rd, r_w5, r_w1, r_out = rate(u.get('model') or r.get('model'))
    cold = (rd + wr) > 0 and wr / (rd + wr) > 0.5
    edits = [e for e in (u.get('appliedEdits') or []) if e.get('type') == 'clear_tool_uses_20250919']
    cleared = sum(e.get('cleared_input_tokens', 0) or 0 for e in edits)
    reason = r.get('reason') or '-'
    # Would stock have been cold here too? Only at a cold moment (first request of a
    # conversation / process, a >55 min gap) or the CLI's own second-request rewrite —
    # a cold answer to a hold is a clearing-induced miss and stock would have been warm.
    prev_ts, prev_reason = s.get('_prev_ts'), s.get('_prev_reason')
    stock_cold = cold and (reason in ('force-first', 'force-cold') or prev_reason in ('force-first', 'force-cold')
                           or prev_ts is None or ts - prev_ts > 55 * 60 or r.get('mode') != 'clear')
    s['_prev_ts'] = ts; s['_prev_reason'] = reason
    if cold and not stock_cold: s['misses'] += 1
    s['tok_read'] += rd; s['tok_write'] += wr; s['tok_in'] += inp; s['tok_out'] += out; s['tok_cleared'] += cleared
    s['ctx_sum'] += rd + wr + inp; s['ctx_max'] = max(s['ctx_max'], rd + wr + inp)
    if cold: s['cold'] += 1
    actual = (rd * r_rd + (w5 or 0) * r_w5 + (w1 or 0) * r_w1 + inp * base + out * r_out) / 1e6
    r_w = (r_w1 if (w1 or 0) >= (w5 or 0) else r_w5)
    if stock_cold:      # stock writes the cleared tokens too
        stock = actual + cleared * r_w / 1e6
    elif cold:          # clearing-induced miss: stock would have read everything and written only the new turn
        stock = ((rd + wr + cleared) * r_rd + WARM_WRITE * r_w + inp * base + out * r_out) / 1e6
    else:               # warm either way: stock reads the cleared tokens as well
        stock = actual + cleared * r_rd / 1e6
    s['usd'] += actual; s['usd_stock'] += stock
    s['reason:' + reason] += 1
    if reason == 'hold': s['holds'] += 1
    if r.get('comp'):
        st = r['comp']['stale']; ch = r['comp']['chars']
        total = sum(v for k, v in ch.items() if k != 'images') or 1
        s['stale_share_sum'] += (st['toolResult'] + st['toolInput']) / total

print(f"ledger {A.ledger} since {datetime.datetime.fromtimestamp(CUT):%Y-%m-%d %H:%M}\n")
print(f"{'session':28} {'mode':5} {'req':>5} {'cold':>4} {'avg ctx':>8} {'max ctx':>8} {'cleared/req':>11} {'stale%':>6} {'$ actual':>9} {'$ stock':>8} {'saved':>7}  steering")
for (sess, mode), s in sorted(S.items(), key=lambda kv: -kv[1]['usd_stock']):
    n = s['req'] or 1
    reasons = ', '.join(f"{k[7:]} {v}" for k, v in sorted(s.items()) if k.startswith('reason:') and k != 'reason:-')
    rc = f"  cold holds (misses) {s['misses']}/{s['holds']}" if s['holds'] else ''
    err = f"  ERRORS api {s['api_errors']} proxy {s['proxy_errors']}" if (s['api_errors'] or s['proxy_errors']) else ''
    saved = s['usd_stock'] - s['usd']
    pct = f"{saved / s['usd_stock'] * 100:.0f}%" if s['usd_stock'] else '-'
    print(f"{sess[:28]:28} {mode:5} {s['req']:5} {s['cold']:4} {s['ctx_sum'] // n // 1000:7}k {s['ctx_max'] // 1000:7}k {s['tok_cleared'] // n // 1000:10}k {s['stale_share_sum'] / n * 100:5.0f}% ${s['usd']:8.2f} ${s['usd_stock']:7.2f} {pct:>7}  {reasons}{rc}{err}")
tot_a = sum(s['usd'] for s in S.values()); tot_s = sum(s['usd_stock'] for s in S.values())
print(f"\ntotal ${tot_a:.2f} actual vs ${tot_s:.2f} stock → saved ${tot_s - tot_a:.2f} ({(tot_s - tot_a) / tot_s * 100 if tot_s else 0:.0f}%); output tokens included in both")
print("stale% = share of the prompt's chars that are tool results/inputs older than the policy's keep (what clearing targets)")
