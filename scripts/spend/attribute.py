import json, glob, os, time, collections, base64, struct, re
CUT = time.time() - 7*86400
def tk(s): return len(s)/3.7
def dims(raw):
    if raw[:8] == b'\x89PNG\r\n\x1a\n': return struct.unpack('>II', raw[16:24])
    if raw[:2] == b'\xff\xd8':
        i = 2
        while i < len(raw)-9:
            if raw[i] != 0xFF: i += 1; continue
            m = raw[i+1]
            if m in (0xC0,0xC1,0xC2,0xC3,0xC5,0xC6,0xC7,0xC9,0xCA,0xCB,0xCD,0xCE,0xCF):
                h,w = struct.unpack('>HH', raw[i+5:i+9]); return w,h
            if m in (0xD8,0xD9) or 0xD0<=m<=0xD7: i += 2; continue
            i += 2 + struct.unpack('>H', raw[i+2:i+4])[0]
    return None
def img_tok(d):
    try: raw = base64.b64decode(d[:400] + '==')
    except Exception: return 1500
    wh = dims(raw)
    if not wh: return 1500
    w,h = wh; m = max(w,h)
    if m > 1568: w,h = int(w*1568/m), int(h*1568/m)
    return (w*h)/750
def blocktoks(b):
    """token size of one content block, image-aware"""
    t = b.get('type')
    if t == 'text': return tk(b.get('text',''))
    if t == 'thinking': return tk(b.get('thinking',''))
    if t == 'image': return img_tok((b.get('source') or {}).get('data',''))
    if t == 'tool_use': return tk(json.dumps(b.get('input',{})))
    if t == 'tool_result':
        cc = b.get('content')
        if isinstance(cc, list): return sum(blocktoks(x) for x in cc if isinstance(x, dict))
        return tk(cc if isinstance(cc,str) else json.dumps(cc))
    return 0
files = [f for f in glob.glob(os.path.expanduser('~/.claude/projects/*/*.jsonl')) if os.path.getmtime(f) > CUT]
def sysprompt(projdir):
    total = 12000  # tool defs + harness preamble
    u = os.path.expanduser('~/CLAUDE.md')
    if os.path.exists(u): total += os.path.getsize(u)/4
    cur = '/' + projdir.strip('-').replace('-','/')
    while cur not in ('/',''):
        c = os.path.join(cur,'CLAUDE.md')
        if os.path.exists(c) and c != u: total += os.path.getsize(c)/4
        cur = os.path.dirname(cur)
    mem = os.path.expanduser(f'~/.claude/projects/{projdir}/memory/MEMORY.md')
    if os.path.exists(mem): total += os.path.getsize(mem)/4
    return total
CR,CW,IN,OUT = .1,1.25,1.,5.
comp = collections.Counter(); usage = collections.Counter(); turns = 0
tt = collections.Counter()   # token-turns per part, for the "what to fix" ranking
for f in files:
    projdir = os.path.basename(os.path.dirname(f)); S = sysprompt(projdir)
    hist = collections.Counter(); id2 = {}
    with open(f) as fh:
        for line in fh:
            try: j = json.loads(line)
            except Exception: continue
            if j.get('type') not in ('user','assistant'): continue
            m = j.get('message') or {}
            if m.get('content') is None: continue
            u = m.get('usage')
            if u and m.get('role')=='assistant':
                cr,cw,ip,op = (u.get('cache_read_input_tokens',0) or 0, u.get('cache_creation_input_tokens',0) or 0,
                               u.get('input_tokens',0) or 0, u.get('output_tokens',0) or 0)
                usage['cache_read']+=cr; usage['cache_write']+=cw; usage['input']+=ip; usage['output']+=op
                pw = cr*CR + cw*CW + ip*IN
                ctx = S + sum(hist.values())
                if ctx>0:
                    comp['System prompt / CLAUDE.md'] += pw*S/ctx
                    for k,v in hist.items(): comp[k] += pw*v/ctx
                comp['Model output (writing)'] += op*OUT
                turns += 1
            c = m.get('content')
            if isinstance(c,str): hist['Conversation text'] += tk(c)
            elif isinstance(c,list):
                for b in c:
                    if not isinstance(b,dict): continue
                    t = b.get('type'); n = blocktoks(b)
                    if t in ('text','thinking'): hist['Conversation text'] += n
                    elif t == 'image': hist['Screenshots / images'] += n
                    elif t == 'tool_use': id2[b.get('id')] = b.get('name'); hist['Tool call args'] += n
                    elif t == 'tool_result':
                        nm = id2.get(b.get('tool_use_id'))
                        cc = b.get('content')
                        imgs = sum(blocktoks(x) for x in cc if isinstance(x,dict) and x.get('type')=='image') if isinstance(cc,list) else 0
                        if imgs: hist['Screenshots / images'] += imgs
                        rest = n - imgs
                        key = {'Read':'Read results (file text)','Bash':'Bash output'}.get(nm,'Other tool results')
                        hist[key] += rest
json.dump({'comp':dict(comp),'usage':dict(usage),'turns':turns}, open('/tmp/spend/data2.json','w'))
T = sum(comp.values()); SPEND = 8536.54
print(f'turns={turns:,}')
for k,v in sorted(comp.items(), key=lambda x:-x[1]):
    print(f'  {v/T*100:5.1f}%  ${v/T*SPEND:7.0f}  {k}')
