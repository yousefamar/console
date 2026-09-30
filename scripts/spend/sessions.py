#!/usr/bin/env python3
"""Rank sessions by $ over a window of the extract.py ledger, with what each one did per dollar.

Usage: python3 sessions.py LEDGER.jsonl [FROM] [TO] [--top N] [--by src|proj|model|effort|day|cwd]
Names come from the hub manifest (live sessions), fork-cost.jsonl (closed forks), the recall
index and the session's first board-dispatch text (card ^id). $ are Bedrock list rates as
computed by extract.py; scale to the billed figure from `con dashboard costs` (~0.87x here).
"""
import json, sys, os, collections, datetime, re

args = [a for a in sys.argv[1:] if not a.startswith('--')]
opts = {a.split('=')[0]: (a.split('=')[1] if '=' in a else True) for a in sys.argv[1:] if a.startswith('--')}
LEDGER = args[0]
def _day(s): return datetime.datetime.fromisoformat(s).timestamp()
CUT = _day(args[1]) if len(args) > 1 else 0
END = _day(args[2]) if len(args) > 2 else 1e18
TOP = int(opts.get('--top', 15))
BY = opts.get('--by')

names = {}; kind = {}
try:
    for s in json.load(open(os.path.expanduser('~/.claude/console-hub-sessions.json'))):
        names[s['claudeSessionId']] = s.get('name') or s.get('agentKey') or ''
except Exception: pass
try:
    for line in open(os.path.expanduser('~/.config/console/fork-cost.jsonl')):
        try: r = json.loads(line)
        except Exception: continue
        names.setdefault(r['claudeSessionId'], r.get('name') or r.get('agentKey') or '')
        kind[r['claudeSessionId']] = r.get('context') or ''
except Exception: pass
try:
    for line in open(os.path.expanduser('~/.cache/spend/session-names.tsv')):
        p = line.rstrip('\n').split('\t')
        if len(p) > 2 and p[1]: names.setdefault(p[0], p[1])
except Exception: pass

S = collections.defaultdict(lambda: collections.Counter())
meta = collections.defaultdict(dict)
first_head = {}
group = collections.defaultdict(lambda: collections.Counter())
for line in open(LEDGER):
    r = json.loads(line)
    if r['ts'] < CUT or r['ts'] >= END: continue
    sid = r['sid']
    if r['k'] == 'wake':
        S[sid]['wakes'] += 1
        S[sid]['w:' + r['src']] += 1
        if sid not in first_head or r['src'] == 'board-dispatch': first_head.setdefault(sid, r['head'])
        if r['src'] == 'board-dispatch':
            m = re.search(r'\^([a-z]+-[a-z]+)', r['head'])
            if m: meta[sid]['card'] = '^' + m.group(1)
        continue
    if r['k'] == 'tr':
        S[sid]['tr_chars'] += r['chars']; S[sid]['imgs'] += r['imgs']
        continue
    s = S[sid]
    s['usd'] += r['usd']; s['rd'] += r['usd_rd']; s['wr'] += r['usd_w']; s['out$'] += r['usd_out']
    s['req'] += 1; s['out'] += r['out']; s['vis'] += r['vis']
    ctx = r['cr'] + r['w5'] + r['w1'] + r['inp']
    s['ctx'] += ctx; s['maxctx'] = max(s['maxctx'], ctx)
    s['m:' + re.sub(r'^claude-|-\d{8}$', '', r['model'])] += 1
    s['e:' + (r['effort'] or '-')] += 1
    s['s:' + r['src']] += r['usd']
    if r['side']: s['side$'] += r['usd']
    meta[sid].setdefault('proj', r['proj']); meta[sid].setdefault('cwd', r['cwd']); meta[sid].setdefault('entry', r['entry'])
    if BY:
        key = {'src': r['src'], 'proj': r['proj'], 'model': r['model'], 'effort': r['effort'], 'cwd': r['cwd'],
               'day': datetime.datetime.fromtimestamp(r['ts'], datetime.timezone.utc).strftime('%m-%d')}[BY]
        g = group[key]; g['usd'] += r['usd']; g['rd'] += r['usd_rd']; g['wr'] += r['usd_w']; g['out$'] += r['usd_out']; g['req'] += 1; g['out'] += r['out']

def nm(sid):
    n = names.get(sid) or meta[sid].get('card') or ''
    if not n:
        h = first_head.get(sid, '')
        n = ('"' + h[:40] + '"') if h else ''
    return (n or '?')[:28]

tot = sum(s['usd'] for s in S.values()); treq = sum(s['req'] for s in S.values())
print(f'{len(S)} sessions, {treq:,} requests, modelled ${tot:,.0f} in window')
if BY:
    print(f'\nby {BY}:')
    for k, g in sorted(group.items(), key=lambda kv: -kv[1]['usd']):
        print(f"  {g['usd']/tot*100:5.1f}%  ${g['usd']:8,.0f}  rd ${g['rd']:7,.0f}  wr ${g['wr']:7,.0f}  out ${g['out$']:6,.0f}  {g['req']:6,} req  {g['out']/max(g['req'],1):5.0f} out/req  {k}")
    sys.exit()

print(f"\n{'$':>7} {'%':>5} {'req':>5} {'wk':>4} {'rd$':>6} {'wr$':>6} {'out$':>5} {'avgctx':>6} {'maxctx':>6} {'out/req':>7} {'model':<9} {'ctx':<5} {'proj':<10} name / dominant wake source")
for sid, s in sorted(S.items(), key=lambda kv: -kv[1]['usd'])[:TOP]:
    models = sorted(((k[2:], v) for k, v in s.items() if k.startswith('m:')), key=lambda kv: -kv[1])
    srcs = sorted(((k[2:], v) for k, v in s.items() if k.startswith('s:')), key=lambda kv: -kv[1])
    dom = srcs[0][0] if srcs else '-'
    if len(srcs) > 1 and srcs[1][1] > 0.2 * s['usd']: dom += f' +{srcs[1][0]}'
    mdl = (models[0][0] if models else '-').replace('fable-5-1', 'F5.1').replace('fable-5', 'F5').replace('opus-5', 'O5').replace('sonnet-5', 'S5').replace('haiku-4-5', 'H4.5')[:9]
    print(f"{s['usd']:7,.0f} {s['usd']/tot*100:5.1f} {s['req']:5,} {s['wakes']:4} {s['rd']:6,.0f} {s['wr']:6,.0f} {s['out$']:5,.0f} {s['ctx']/max(s['req'],1)/1000:5.0f}k {s['maxctx']/1000:5.0f}k {s['out']/max(s['req'],1):7.0f} {mdl:<9} {kind.get(sid,'')[:5]:<5} {meta[sid].get('proj','')[:10]:<10} {nm(sid)}  [{dom}]  {sid[:8]}")
