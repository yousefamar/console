import json, glob, os, time, collections, datetime
CUT=time.time()-7*86400
files=[f for f in glob.glob(os.path.expanduser('~/.claude/projects/*/*.jsonl')) if os.path.getmtime(f)>CUT]
def parse(ts):
    try: return datetime.datetime.fromisoformat(ts.replace('Z','+00:00')).timestamp()
    except Exception: return None
buckets=collections.Counter(); bn=collections.Counter()
cold_w=warm_w=read_w=0
for f in files:
    seen=set(); last=None
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
            ts=parse(j.get('timestamp') or ''); gap=(ts-last) if (ts and last) else None; last=ts or last
            read_w += cr*0.1
            if cw/max(cr+cw,1) > 0.5:
                cold_w += cw*1.25
                b = ('first request of the session' if gap is None else
                     'gap < 5 min (inside the 5-min TTL)' if gap < 300 else
                     'gap 5–30 min (TTL lapsed)' if gap < 1800 else
                     'gap 30 min–2 h (hibernated: we SIGKILL idle sessions at 30 min)' if gap < 7200 else
                     'gap > 2 h (woken by cron / board dispatch / Yousef)')
                buckets[b]+=cw*1.25; bn[b]+=1
            else:
                warm_w += cw*1.25
T = cold_w+warm_w+read_w
SP = 8536.54
print(f'DEDUPED, {sum(bn.values()):,} cold requests')
print(f'  {cold_w/T*100:5.1f}%  ${cold_w/T*SP:7.0f}  COLD: whole prompt re-written at 1.25x')
print(f'  {read_w/T*100:5.1f}%  ${read_w/T*SP:7.0f}  re-reading the cached prefix at 0.1x  ← "N messages later"')
print(f'  {warm_w/T*100:5.1f}%  ${warm_w/T*SP:7.0f}  WARM: only the new content written')
print('\nwhy each cold request was cold:')
C=sum(buckets.values())
for k,v in buckets.most_common():
    print(f'  {v/C*100:5.1f}%  ${v/C*(cold_w/T*SP):7.0f}  {bn[k]:5,} reqs  {k}')
