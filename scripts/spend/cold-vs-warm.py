"""Cold vs warm cache-write attribution, priced at real Bedrock rates.

Cold = a request whose input was mostly WRITTEN to cache rather than read
(cw/(cr+cw) > 0.5): the whole prompt was rebuilt. Buckets each cold request by
the gap since the previous request in the same transcript, because the gap
names the fixable cause:
  ≤5m    : cache-invalidating change (edit/model/effort) — TTL never lapsed
  5–30m  : 5m-TTL lapse, process still alive (hibernate sweep fires at 30m)
  30–60m : hibernation window — saveable only by 1h TTL + not hibernating
  >60m   : beyond max TTL — unavoidable rewrite; SIZE is the only lever
Prices per MTok: cache write 5m = 1.25x base input, 1h = 2x; reads: Fable 5.1
repriced to $0.25 (0.025x), everything else 0.1x base. Dedupe is GLOBAL by
message.id: fork-session copies duplicate the parent's transcript lines.
"""
import json, glob, os, time, collections, datetime, statistics

CUT = time.time() - 7 * 86400
files = [f for f in glob.glob(os.path.expanduser('~/.claude/projects/*/*.jsonl')) if os.path.getmtime(f) > CUT]

# $/MTok: (base_input, read, write_5m, write_1h, output)
RATES = {
    'fable-5-1':  (10, 0.25, 12.5, 20, 50),
    'fable-5':    (10, 1.00, 12.5, 20, 50),
    'opus':       (5,  0.50, 6.25, 10, 25),
    'sonnet-4':   (3,  0.30, 3.75, 6,  15),
    'sonnet':     (2,  0.20, 2.5,  4,  10),
    'haiku':      (1,  0.10, 1.25, 2,  5),
}
def rate(model):
    m = model or ''
    for k, v in RATES.items():
        if k in m: return v
    return RATES['fable-5-1']

def parse(ts):
    try: return datetime.datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp()
    except Exception: return None

seen = set()
usd = collections.Counter()          # by class: cold/warm-write/read/input/output
cold_usd = collections.Counter(); cold_n = collections.Counter()
cold_tok = collections.Counter()
save_ttl = 0.0                       # 5–60m cold writes if they'd been warm reads instead
over60_sizes = []
first_req_sizes = []

BUCKETS = [
    (300,     'gap ≤ 5 min (cache-invalidating change, not a TTL lapse)'),
    (1800,    'gap 5–30 min (5m-TTL lapse, process still alive)'),
    (3600,    'gap 30–60 min (hibernation window; 1h TTL would have saved it)'),
    (7200,    'gap 1–2 h (beyond max TTL)'),
    (10**12,  'gap > 2 h (cron / board dispatch / Yousef wake)'),
]

for f in files:
    last = None
    with open(f) as fh:
        for line in fh:
            try: j = json.loads(line)
            except Exception: continue
            m = j.get('message') or {}
            if m.get('role') != 'assistant': continue
            u = m.get('usage')
            if not u: continue
            mid = m.get('id')
            ts = parse(j.get('timestamp') or '')
            if ts and ts < CUT: continue   # files hold lines far older than their mtime
            if mid:
                if mid in seen:
                    last = ts or last   # keep gap clock honest on dup lines
                    continue
                seen.add(mid)
            cr = u.get('cache_read_input_tokens', 0) or 0
            cw = u.get('cache_creation_input_tokens', 0) or 0
            cc = u.get('cache_creation') or {}
            w1h = cc.get('ephemeral_1h_input_tokens', 0) or 0
            w5m = cc.get('ephemeral_5m_input_tokens', 0) or (cw - w1h if cc else cw)
            ip = u.get('input_tokens', 0) or 0
            op = u.get('output_tokens', 0) or 0
            base, r_rd, r_w5, r_w1, r_out = rate(m.get('model'))
            wr_usd = (w5m * r_w5 + w1h * r_w1) / 1e6
            usd['read'] += cr * r_rd / 1e6
            usd['input'] += ip * base / 1e6
            usd['output'] += op * r_out / 1e6
            gap = (ts - last) if (ts and last) else None
            last = ts or last
            if cw / max(cr + cw, 1) > 0.5:
                usd['cold-write'] += wr_usd
                if gap is None:
                    b = 'first request of the session (fresh spawn / fork)'
                    first_req_sizes.append(cw)
                else:
                    b = next(lbl for lim, lbl in BUCKETS if gap < lim)
                    if 300 <= gap < 3600:
                        save_ttl += wr_usd - (cw * 0.25 / 1e6 if 'fable-5-1' in (m.get('model') or '') else cw * r_rd / 1e6)
                    if gap >= 3600: over60_sizes.append(cw)
                cold_usd[b] += wr_usd; cold_n[b] += 1; cold_tok[b] += cw
            else:
                usd['warm-write'] += wr_usd

T = sum(usd.values())
print(f'{len(seen):,} deduped requests, {sum(cold_n.values()):,} cold — modelled ${T:,.0f}/wk at list Bedrock rates')
for k in ('cold-write', 'warm-write', 'read', 'output', 'input'):
    print(f'  {usd[k]/T*100:5.1f}%  ${usd[k]:7,.0f}  {k}')
print('\nwhy each cold request was cold ($ = write cost at real rates):')
for k, v in cold_usd.most_common():
    print(f'  {v/max(sum(cold_usd.values()),1)*100:5.1f}%  ${v:7,.0f}  {cold_n[k]:5,} reqs  {cold_tok[k]/max(cold_n[k],1)/1000:6.0f}k avg  {k}')
print(f'\nif every 5–60min cold request had instead been a warm read (1h TTL, no hibernate <60m): saves ${save_ttl:,.0f}/wk')
if over60_sizes:
    print(f'>60min rewrites: median {statistics.median(over60_sizes)/1000:.0f}k, mean {statistics.mean(over60_sizes)/1000:.0f}k tokens — the microcompact/diet lever')
if first_req_sizes:
    print(f'first-request writes: median {statistics.median(first_req_sizes)/1000:.0f}k, mean {statistics.mean(first_req_sizes)/1000:.0f}k tokens — the fork-spawn/CLAUDE.md-diet lever')
