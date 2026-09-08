import json, glob, os, time, datetime, collections
CUT=time.time()-7*86400
files=[f for f in glob.glob(os.path.expanduser('~/.claude/projects/*/*.jsonl')) if os.path.getmtime(f)>CUT]
def parse(ts):
    try: return datetime.datetime.fromisoformat(ts.replace('Z','+00:00')).timestamp()
    except Exception: return None
W5,W1H,R = 1.25,2.0,0.1
tot5=tot1h=totBest=0; pick=collections.Counter(); rows=[]
for f in files:
    seen=set(); last=None; c5=c1h=0
    with open(f) as fh:
        for line in fh:
            try: j=json.loads(line)
            except Exception: continue
            m=j.get('message') or {}
            if m.get('role')!='assistant': continue
            u=m.get('usage')
            if not u: continue
            mid=m.get('id')
            if mid:
                if mid in seen: continue
                seen.add(mid)
            cr=u.get('cache_read_input_tokens',0) or 0; cw=u.get('cache_creation_input_tokens',0) or 0
            ip=u.get('input_tokens',0) or 0; op=u.get('output_tokens',0) or 0
            ts=parse(j.get('timestamp') or ''); gap=(ts-last) if (ts and last) else None; last=ts or last
            base=ip+op*5
            cold = cw/max(cr+cw,1)>0.5
            c5 += base + cr*R + cw*W5
            if cold and gap is not None and 300<=gap<=3600:
                c1h += base + (cr+cw*0.95)*R + (cw*0.05)*W1H
            else:
                c1h += base + cr*R + cw*W1H
    tot5+=c5; tot1h+=c1h; totBest+=min(c5,c1h)
    pick['1h' if c1h<c5 else '5m'] += 1
    rows.append((min(c5,c1h)/max(c5,1), os.path.basename(os.path.dirname(f))[:44], c5, c1h))
SP=8536.54; sc=SP/tot5
print(f'sessions preferring 1h: {pick["1h"]}   preferring 5m: {pick["5m"]}')
print(f'all-5m (today):        ${tot5*sc:,.0f}/wk')
print(f'all-1h:                ${tot1h*sc:,.0f}/wk')
print(f'per-session best:      ${totBest*sc:,.0f}/wk  → saves ${(tot5-totBest)*sc:,.0f}/wk = ${(tot5-totBest)*sc*52/12:,.0f}/month')
rows.sort(key=lambda r: r[2]-r[3], reverse=True)
print('\nbiggest winners from 1h (project, $ saved/wk):')
for r in rows[:6]:
    if r[2]-r[3] > 0: print(f'  ${(r[2]-r[3])*sc:7.0f}  {r[1]}')
