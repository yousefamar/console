#!/usr/bin/env python3
"""Price stale tool results and simulate clearing policies over real transcripts.

Replays every request in ~/.claude/projects/*/*.jsonl in order, keeps the running
transcript composition (tool results, tool_use inputs, assistant text, user text,
images) and, for each request, prices what the API's `usage` says was read/written
against what it WOULD have been had old tool results been cleared.

Policies (all keep the N most recent tool uses; `exclude` tools are never cleared):
  api      — the API's `clear_tool_uses_20250919` as measured on Bedrock: when the
             retained prompt crosses `trigger` it clears all results but the last
             `keep` (one cold write of the small retained prompt) and then FREEZES that
             cleared set while the cache lives, so warm calls read only the retained
             context; a dead cache re-clears for free.
  cold     — proxy-side: rewrite history only on requests that were already cold
             (cw/(cr+cw) > 0.5 — hub restart, >TTL gap, fresh spawn); the rewrite is
             free because the cache was dead anyway; frozen byte-stable until the next
             cold request, so warm requests only lose the cleared reads.
  hybrid   — `cold` plus a deliberate rewrite whenever uncleared stale tool results
             exceed `--refresh` tokens (pays one write to start saving reads).

Token sizes: the API's own usage (cr+cw+input) is the context size; the transcript's
char split (chars/3.7, images 1,844 tok) only apportions it. The fixed prefix (system
prompt + tools, absent from the JSONL) is the first request's context minus its
transcript estimate. Sidechain (subagent) lines are costed as stock, not simulated.

Usage: python3 clear-sim.py FROM TO [--keep 3] [--trigger 100000] [--refresh 200000]
                             [--exclude Read,Edit] [--top 12]        (dates local, TO exclusive)
"""
import json, os, sys, glob, datetime, collections, argparse

ap = argparse.ArgumentParser()
ap.add_argument('frm'); ap.add_argument('to')
ap.add_argument('--keep', type=int, default=3)
ap.add_argument('--trigger', type=int, default=100_000)
ap.add_argument('--refresh', type=int, default=200_000)
ap.add_argument('--exclude', default='')
ap.add_argument('--inputs', action='store_true', help='also clear the tool_use inputs (clear_tool_inputs: true)')
ap.add_argument('--top', type=int, default=12)
ap.add_argument('--json', help='write per-request rows here')
A = ap.parse_args()
EXCLUDE = set(x for x in A.exclude.split(',') if x)

def _day(s): return datetime.datetime.fromisoformat(s).timestamp()
CUT, END = _day(A.frm), _day(A.to)

# LIST price, Bedrock bills 1.10x. No 'opus-4' row on purpose — Opus 4.8 bills the same as
# Opus 5; the old (15, 1.50, 18.75, 30, 75) row was 3x too high. Evidence: extract.py RATES.
RATES = {  # $/MTok: (base_input, read, write_5m, write_1h, output)
    'fable-5-1': (10, 0.25, 12.5, 20, 50), 'fable-5': (10, 1.00, 12.5, 20, 50),
    'opus-5-5': (4, 0.20, 5, 8, 20), 'opus': (5, 0.50, 6.25, 10, 25),
    'sonnet-4': (3, 0.30, 3.75, 6, 15), 'sonnet': (2, 0.20, 2.5, 4, 10),
    'haiku': (1, 0.10, 1.25, 2, 5),
}
def rate(model):
    m = model or ''
    for k, v in RATES.items():
        if k in m: return v
    return RATES['fable-5-1']
def short(model):
    for k in RATES:
        if k in (model or ''): return k
    return 'other'

CPT = 3.7           # chars per token (relative split only)
IMG_CHARS = 1844 * CPT

def parse(ts):
    try: return datetime.datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp()
    except Exception: return None

files = [f for f in glob.glob(os.path.expanduser('~/.claude/projects/*/*.jsonl')) if os.path.getmtime(f) > CUT]

POL = ('api', 'cold', 'hybrid')
tot = {p: collections.Counter() for p in ('stock',) + POL}     # $ by (model, class)
n_req = collections.Counter(); n_sim = 0; n_side = 0
sess = collections.defaultdict(lambda: collections.Counter())  # per session $ deltas
stale_usd = collections.Counter()   # $ actually paid for clearable tool results, by class
ctx_hist = collections.Counter()    # requests by context bucket, with clearable share
costed = set()
rows = []
n_api_clear = [0]

class Hist:
    """Ordered transcript entries: (kind, chars, tool_name)."""
    def __init__(self):
        self.e = []; self.tools = {}; self.sys_tok = None
        self.frozen = None      # cold/hybrid: set of entry idx cleared, frozen chars
        self.frozen_h = None
    def add(self, kind, chars, name=None, tid=None): self.e.append((kind, chars, name, tid))
    def chars(self): return sum(c for _, c, _, _ in self.e)
    def tr_indices(self):
        return [i for i, (k, _, n, _) in enumerate(self.e) if k == 'tr' and n not in EXCLUDE]
    def compact(self, summary_chars):
        # Claude Code auto-compaction: the billed context restarts from the summary.
        self.e = [('usr', summary_chars, None, None)]
        for k in ('fz_c', 'fz_h', 'fz_api'):
            if hasattr(self, k): delattr(self, k)

def clearable_set(H, trs):
    """Indices cleared under keep=N: the tool results (and, with --inputs, their
    tool_use blocks — the entry just before each result, skipping interleaved text)."""
    idx = trs[:-A.keep] if len(trs) > A.keep else []
    if not A.inputs or not idx: return idx
    ids = {H.e[i][3] for i in idx}
    return sorted(set(idx) | {i for i, (k, _, _, t) in enumerate(H.e) if k == 'tu' and t in ids})

for f in files:
    fid = os.path.basename(f)[:8]
    try: fh = open(f, errors='replace')
    except OSError: continue
    H = Hist(); prev_cold = None
    for line in fh:
        if len(line) < 20: continue
        try: d = json.loads(line)
        except Exception: continue
        typ = d.get('type'); m = d.get('message') or {}
        if d.get('isSidechain'):
            if typ == 'assistant' and m.get('usage'):
                mid = m.get('id') or f'{fid}:{d.get("uuid")}'
                ts = parse(d.get('timestamp') or '')
                if mid not in costed and ts and CUT <= ts < END:
                    costed.add(mid); u = m['usage']
                    base, r_rd, r_w5, r_w1, r_out = rate(m.get('model'))
                    cr = u.get('cache_read_input_tokens', 0) or 0; cw = u.get('cache_creation_input_tokens', 0) or 0
                    cc = u.get('cache_creation') or {}; w1 = cc.get('ephemeral_1h_input_tokens', 0) or 0
                    w5 = cc.get('ephemeral_5m_input_tokens', 0) or (cw - w1 if cc else cw)
                    usd = (cr * r_rd + w5 * r_w5 + w1 * r_w1 + (u.get('input_tokens', 0) or 0) * base) / 1e6
                    tot['stock'][(short(m.get('model')), 'side')] += usd
                    for p in POL: tot[p][(short(m.get('model')), 'side')] += usd
                    n_side += 1
            continue
        if typ == 'user':
            c = m.get('content')
            first = c if isinstance(c, str) else next((b.get('text') or '' for b in c if isinstance(b, dict) and b.get('type') == 'text'), '') if isinstance(c, list) else ''
            if d.get('isCompactSummary') or first.lstrip().startswith('This session is being continued'):
                H.compact(len(first)); continue
            if isinstance(c, str): H.add('usr', len(c))
            elif isinstance(c, list):
                for b in c:
                    if not isinstance(b, dict): continue
                    bt = b.get('type')
                    if bt == 'text': H.add('usr', len(b.get('text') or ''))
                    elif bt == 'image': H.add('usr', IMG_CHARS)
                    elif bt == 'tool_result':
                        cc = b.get('content'); ch = 0
                        if isinstance(cc, str): ch = len(cc)
                        elif isinstance(cc, list):
                            for x in cc:
                                if not isinstance(x, dict): continue
                                if x.get('type') == 'text': ch += len(x.get('text') or '')
                                elif x.get('type') == 'image': ch += IMG_CHARS
                        H.add('tr', ch + 40, H.tools.get(b.get('tool_use_id')), b.get('tool_use_id'))
            continue
        if typ != 'assistant' or m.get('role') != 'assistant': continue
        # content blocks always enter the history (multi-line turns share one message.id)
        for b in m.get('content') or []:
            if not isinstance(b, dict): continue
            bt = b.get('type')
            if bt == 'text': H.add('txt', len(b.get('text') or ''))
            elif bt == 'tool_use':
                H.tools[b.get('id')] = b.get('name')
                try: H.add('tu', len(json.dumps(b.get('input') or {})) + 60, b.get('name'), b.get('id'))
                except Exception: H.add('tu', 60, b.get('name'), b.get('id'))
        u = m.get('usage')
        if not u: continue
        mid = m.get('id') or f'{fid}:{d.get("uuid")}'
        if mid in costed: continue
        costed.add(mid)
        ts = parse(d.get('timestamp') or '')
        cr = u.get('cache_read_input_tokens', 0) or 0; cw = u.get('cache_creation_input_tokens', 0) or 0
        ip = u.get('input_tokens', 0) or 0
        ctx = cr + cw + ip
        if ctx == 0: continue
        cc = u.get('cache_creation') or {}
        w1 = cc.get('ephemeral_1h_input_tokens', 0) or 0
        w5 = cc.get('ephemeral_5m_input_tokens', 0) or (cw - w1 if cc else cw)
        f1 = (w1 / cw) if cw else 1.0          # TTL mix of writes (1h share)
        model = m.get('model') or ''; base, r_rd, r_w5, r_w1, r_out = rate(model)
        r_w = f1 * r_w1 + (1 - f1) * r_w5
        tchars = H.chars()
        if H.sys_tok is None:
            H.sys_tok = max(0, ctx - tchars / CPT)
        tr_tok = max(ctx - H.sys_tok, 1)       # tokens the transcript occupies
        tpc = tr_tok / max(tchars, 1)          # tokens per char for this request
        cold = cw / (cr + cw) > 0.5 if (cr + cw) else True
        in_window = ts is not None and CUT <= ts < END
        mk = short(model)

        stock_usd = (cr * r_rd + w5 * r_w5 + w1 * r_w1 + ip * base) / 1e6
        if in_window:
            n_req[mk] += 1
            tot['stock'][(mk, 'read')] += cr * r_rd / 1e6
            tot['stock'][(mk, 'write')] += (w5 * r_w5 + w1 * r_w1 + ip * base) / 1e6

        trs = H.tr_indices()
        clearable = clearable_set(H, trs)
        clearable_chars = sum(H.e[i][1] for i in clearable)
        clear_tok = clearable_chars * tpc
        if in_window:
            stale_usd[(mk, 'cold' if cold else 'warm')] += clear_tok * (r_w if cold else r_rd) / 1e6
            b = min(ctx // 100_000, 9)
            ctx_hist[(b, 'n')] += 1; ctx_hist[(b, 'share')] += clear_tok / ctx

        # --- api policy: measured on Bedrock 2026-10-01 (scripts/spend/context-probe.ts):
        # the API clears ALL results but the last `keep` when the retained prompt
        # crosses `trigger` (one cold write of the small retained prompt), then
        # FREEZES that cleared set while the cache lives — warm calls read only the
        # retained context. A dead cache (stock-cold request) re-clears for free.
        fz = H.__dict__.setdefault('fz_api', {'set': set()})
        kept_clear = sum(H.e[i][1] for i in fz['set'] if i < len(H.e)) * tpc
        retained = ctx - kept_clear
        if clearable and (cold or retained > A.trigger):
            fz['set'] = set(clearable)
            retained = ctx - clear_tok
            rd_srv, w_srv = (cr if cold else 0), max(cw - clear_tok, 0) if cold else retained
            n_api_clear[0] += 1
        else:
            rd_srv, w_srv = (cr if cold else max(cr - kept_clear, 0)), cw
        srv_usd = (rd_srv * r_rd + w_srv * r_w + ip * base) / 1e6

        # --- cold / hybrid: proxy-side frozen clears ---
        def frozen_policy(refresh):
            key = 'h' if refresh else 'c'
            fz = getattr(H, 'fz_' + key, None)
            if fz is None: fz = {'set': set(), 'chars': 0}; setattr(H, 'fz_' + key, fz)
            uncleared = clearable_chars - sum(H.e[i][1] for i in clearable if i in fz['set'])
            do_clear = cold or (refresh and uncleared * tpc > refresh)
            if do_clear and clearable:
                paid = 0 if cold else sum(c for _, c, _, _ in H.e[clearable[-1]:]) * tpc  # deliberate rewrite
                fz['set'] = set(clearable); fz['chars'] = clearable_chars
                ct = clearable_chars * tpc
                if cold: return cr, max(cw - ct, 0)
                return max(ctx - ct - max(cw, paid), 0), max(cw, paid)
            ct = sum(H.e[i][1] for i in fz['set'] if i < len(H.e)) * tpc
            if cold: return cr, max(cw - ct, 0)
            return max(cr - ct, 0), cw
        rd_c, w_c = frozen_policy(0)
        rd_h, w_h = frozen_policy(A.refresh)
        cold_usd = (rd_c * r_rd + w_c * r_w + ip * base) / 1e6
        hyb_usd = (rd_h * r_rd + w_h * r_w + ip * base) / 1e6

        if in_window:
            n_sim += 1
            for p, rd, w in (('api', rd_srv, w_srv), ('cold', rd_c, w_c), ('hybrid', rd_h, w_h)):
                tot[p][(mk, 'read')] += rd * r_rd / 1e6
                tot[p][(mk, 'write')] += (w * r_w + ip * base) / 1e6
            s = sess[d.get('sessionId') or fid]
            s['stock'] += stock_usd; s['api'] += srv_usd; s['cold'] += cold_usd; s['hybrid'] += hyb_usd
            s['n'] += 1; s['max_ctx'] = max(s['max_ctx'], ctx); s['cwd'] = 0
            if A.json:
                rows.append({'ts': ts, 'sid': d.get('sessionId') or fid, 'model': mk, 'ctx': ctx, 'cold': cold,
                             'clear_tok': round(clear_tok), 'stock': stock_usd, 'api': srv_usd, 'cold_p': cold_usd, 'hybrid': hyb_usd})

def S(p, cls=None):
    return sum(v for (mk, c), v in tot[p].items() if cls is None or c == cls)

days = (END - CUT) / 86400
print(f'{len(files)} files, {sum(n_req.values()):,} requests in window ({n_sim:,} simulated, {n_side:,} sidechain stock-only), '
      f'{days:.0f} days  keep={A.keep} trigger={A.trigger:,} refresh={A.refresh:,} exclude={sorted(EXCLUDE) or "-"} inputs={A.inputs}')
print(f'\n$ paid for CLEARABLE tool results (older than the last {A.keep} tool uses), i.e. the upper bound:')
for (mk, c), v in sorted(stale_usd.items(), key=lambda kv: -kv[1]):
    print(f'  {mk:10} {c:5} ${v:9,.0f}  (${v/days*7:8,.0f}/wk)')
print(f'  {"total":10}       ${sum(stale_usd.values()):9,.0f}  (${sum(stale_usd.values())/days*7:8,.0f}/wk)   vs stock input ${S("stock"):,.0f}  → {sum(stale_usd.values())/S("stock")*100:.0f}% of input spend')

print(f'\nclearable share of context by context size:')
for b in range(10):
    n = ctx_hist[(b, 'n')]
    if n: print(f'  {b*100:>4}k–{(b+1)*100:<4}k  {n:6,} req  clearable {ctx_hist[(b,"share")]/n*100:4.0f}% of ctx')

print(f'\ninput $ by policy (output tokens excluded; /wk) — api policy fired {n_api_clear[0]:,} clears:')
print(f'  {"policy":8} {"total":>10} {"reads":>9} {"writes":>9}   {"Δ vs stock":>11}')
for p in ('stock',) + POL:
    t, r, w = S(p), S(p, 'read'), S(p, 'write')
    d_ = t - S('stock')
    print(f'  {p:8} ${t/days*7:9,.0f} ${r/days*7:8,.0f} ${w/days*7:8,.0f}   {d_/days*7:+10,.0f}  ({d_/S("stock")*100:+.0f}%)')

print(f'\nby model (/wk):')
for mk in sorted(n_req, key=lambda k: -n_req[k]):
    line = f'  {mk:10} {n_req[mk]:6,} req  stock ${sum(v for (m_,c),v in tot["stock"].items() if m_==mk)/days*7:8,.0f}'
    for p in POL:
        line += f'  {p} ${sum(v for (m_,c),v in tot[p].items() if m_==mk)/days*7:8,.0f}'
    print(line)

print(f'\ntop {A.top} sessions by stock $ (window):')
print(f'  {"session":10} {"req":>5} {"maxctx":>7} {"stock":>8} {"api":>8} {"cold":>8} {"hybrid":>8}')
for sid, s in sorted(sess.items(), key=lambda kv: -kv[1]['stock'])[:A.top]:
    print(f'  {sid[:8]:10} {s["n"]:5,} {s["max_ctx"]//1000:6,}k ${s["stock"]:7,.0f} ${s["api"]:7,.0f} ${s["cold"]:7,.0f} ${s["hybrid"]:7,.0f}')

if A.json:
    with open(A.json, 'w') as fh:
        for r in rows: fh.write(json.dumps(r) + '\n')
    print(f'\nrows → {A.json}')
