#!/usr/bin/env python3
"""Flatten ~/.claude/projects/*/*.jsonl into one compact per-request ledger for the other spend scripts.

One JSON line per unique assistant `message.id` (global dedupe — transcript-copy forks re-list
their parent's lines, and the CLI logs ~40% of requests twice) with the API's own `usage`
split, the model, CLI version, effort, session id, cwd and a $ figure at Bedrock list rates
(cache write 5m = 1.25x base, 1h = 2x; Fable 5.1 reads $0.25/MTok, others 0.1x base).
User lines become wake records (source classified as in requests.py) and tool-result size
records (chars + image count) so context growth can be attributed per session.

Usage: python3 extract.py FROM TO OUT.jsonl      (dates YYYY-MM-DD local, TO exclusive)
Cut on each line's own timestamp, never file mtime (files hold weeks of history).
"""
import json, os, sys, glob, datetime, collections

FROM, TO, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
def _day(s): return datetime.datetime.fromisoformat(s).timestamp()
CUT, END = _day(FROM), _day(TO)

RATES = {  # $/MTok: (base_input, read, write_5m, write_1h, output)
    'fable-5-1': (10, 0.25, 12.5, 20, 50), 'fable-5': (10, 1.00, 12.5, 20, 50),
    'opus-4': (15, 1.50, 18.75, 30, 75), 'opus': (5, 0.50, 6.25, 10, 25),
    'sonnet-4': (3, 0.30, 3.75, 6, 15), 'sonnet': (2, 0.20, 2.5, 4, 10),
    'haiku': (1, 0.10, 1.25, 2, 5),
}
def rate(model):
    m = model or ''
    for k, v in RATES.items():
        if k in m: return v
    return RATES['fable-5-1']

cron_prefixes = {}
try:
    for t in json.load(open(os.path.expanduser('~/.config/console/agent-cron.json'))).get('tasks', []):
        if t.get('prompt'): cron_prefixes[t['prompt'][:64]] = t.get('id', '?')
except Exception: pass

def classify(text):
    t = text.lstrip()
    for pfx, src in (('[BOARD TASK', 'board-dispatch'), ('[CARD APPROVED', 'board-approve'),
                     ('[MERGE — folding you back', 'merge-child-summary'), ('[MERGE - folding', 'merge-child-summary'),
                     ('[MERGE', 'merge-parent-absorb'), ('[FORK — branched', 'fork-seed'), ('[EVENT', 'listener'),
                     ('[WEBHOOK', 'webhook'), ('[VOICE CALL', 'voice-call'), ('[INBOUND', 'al-inbound-chat'),
                     ('[CONVERSATION FORK', 'al-conv-fork'), ('[Forked side-conversation', 'agent-chat'),
                     ('<task-notification', 'task-notif'), ('The hub was restarted, which interrupted', 'hub-restart-nudge'),
                     ('The previous request hit a transient API error', 'api-retry'), ('[MAILBOX PROVISIONED', 'mailbox'),
                     ('[BOARD — ', 'board-reminder'), ('[REVIEW', 'review'), ('[WIND-DOWN', 'wind-down'),
                     ('Your role charter/system prompt was just reloaded', 'reload'), ('You are (re)starting', 'boot'),
                     ('Booted by Console hub', 'boot')):
        if t.startswith(pfx): return src
    if t.startswith('Base directory for this skill') or t.startswith('This session is being continued'): return None
    if t.startswith('<local-command') or t.startswith('<command-name'): return 'user'
    if t[:64] in cron_prefixes: return 'cron:' + cron_prefixes[t[:64]]
    if '--- guard output (' in t[:4000]: return 'cron:removed-or-old'
    return 'user?'

files = [f for f in glob.glob(os.path.expanduser('~/.claude/projects/*/*.jsonl')) if os.path.getmtime(f) > CUT]
seen = {}          # message.id -> index into out (to lift output_tokens on dup lines)
out = []
wakes = []
seen_wake = set()
n_lines = 0

def parse(ts):
    try: return datetime.datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp()
    except Exception: return None

for f in files:
    proj = os.path.basename(os.path.dirname(f)).replace('-home-amar-', '').replace('sync-brain-root-projects-', '')
    fid = os.path.basename(f)[:8]
    try: fh = open(f, errors='replace')
    except OSError: continue
    cur_src = 'unknown'
    for line in fh:
        if len(line) < 20: continue
        n_lines += 1
        try: d = json.loads(line)
        except Exception: continue
        ts = parse(d.get('timestamp') or '')
        if ts is None or ts < CUT or ts >= END: continue
        typ = d.get('type')
        m = d.get('message') or {}
        sid = d.get('sessionId') or fid
        if typ == 'user':
            c = m.get('content'); text = None; tr_chars = 0; imgs = 0; n_tr = 0
            if isinstance(c, str): text = c
            elif isinstance(c, list):
                for b in c:
                    if not isinstance(b, dict): continue
                    bt = b.get('type')
                    if bt == 'text' and text is None: text = b.get('text') or ''
                    elif bt == 'image': imgs += 1
                    elif bt == 'tool_result':
                        n_tr += 1
                        cc = b.get('content')
                        if isinstance(cc, str): tr_chars += len(cc)
                        elif isinstance(cc, list):
                            for x in cc:
                                if isinstance(x, dict):
                                    if x.get('type') == 'text': tr_chars += len(x.get('text') or '')
                                    elif x.get('type') == 'image': imgs += 1
            if n_tr or imgs:
                out.append({'k': 'tr', 'ts': ts, 'sid': sid, 'fid': fid, 'proj': proj, 'chars': tr_chars, 'imgs': imgs, 'n': n_tr, 'src': cur_src,
                            'side': bool(d.get('isSidechain'))})
            if text is not None and not d.get('isSidechain'):
                src = classify(text)
                if src is not None:
                    cur_src = src
                    key = (round(ts), text[:80])
                    if key not in seen_wake:
                        seen_wake.add(key)
                        wakes.append({'k': 'wake', 'ts': ts, 'sid': sid, 'fid': fid, 'proj': proj, 'src': src, 'len': len(text),
                                      'head': text.lstrip()[:120].replace('\n', ' ')})
            continue
        if typ != 'assistant' or m.get('role') != 'assistant': continue
        u = m.get('usage')
        if not u: continue
        mid = m.get('id') or f'{fid}:{d.get("uuid")}'
        op = u.get('output_tokens', 0) or 0
        if mid in seen:
            r = out[seen[mid]]
            if op > r['out']:
                r['usd'] += (op - r['out']) * r['r_out'] / 1e6
                r['out'] = op
            continue
        cr = u.get('cache_read_input_tokens', 0) or 0
        cw = u.get('cache_creation_input_tokens', 0) or 0
        cc = u.get('cache_creation') or {}
        w1h = cc.get('ephemeral_1h_input_tokens', 0) or 0
        w5m = cc.get('ephemeral_5m_input_tokens', 0) or (cw - w1h if cc else cw)
        ip = u.get('input_tokens', 0) or 0
        model = m.get('model') or ''
        base, r_rd, r_w5, r_w1, r_out = rate(model)
        usd = (cr * r_rd + w5m * r_w5 + w1h * r_w1 + ip * base + op * r_out) / 1e6
        vis = 0; ntool = 0; tools = []
        for b in m.get('content') or []:
            if not isinstance(b, dict): continue
            if b.get('type') == 'text': vis += len(b.get('text') or '')
            elif b.get('type') == 'tool_use':
                ntool += 1; tools.append(b.get('name') or '?')
                try: vis += len(json.dumps(b.get('input') or {}))
                except Exception: pass
        seen[mid] = len(out)
        out.append({'k': 'req', 'ts': ts, 'sid': sid, 'fid': fid, 'proj': proj, 'cwd': d.get('cwd') or '', 'model': model,
                    'ver': d.get('version') or '', 'effort': d.get('effort') or '', 'entry': d.get('entrypoint') or '',
                    'side': bool(d.get('isSidechain')), 'cr': cr, 'w5': w5m, 'w1': w1h, 'inp': ip, 'out': op,
                    'usd': usd, 'r_out': r_out, 'usd_rd': cr * r_rd / 1e6, 'usd_w': (w5m * r_w5 + w1h * r_w1) / 1e6,
                    'usd_out': op * r_out / 1e6, 'vis': vis, 'ntool': ntool, 'tools': tools[:6], 'stop': m.get('stop_reason') or '',
                    'src': cur_src})

out.extend(wakes)
out.sort(key=lambda r: r['ts'])
with open(OUT, 'w') as fh:
    for r in out:
        r.pop('r_out', None)
        fh.write(json.dumps(r, separators=(',', ':')) + '\n')
nreq = sum(1 for r in out if r['k'] == 'req')
print(f'{len(files)} files, {n_lines:,} lines → {nreq:,} requests, {len(wakes):,} wakes, {len(out)-nreq-len(wakes):,} tool-result records → {OUT}')
