import json, re, sys

TAKES = ['20260930_160955','20260930_161136','20260930_161301']

def norm(s):
    return re.sub(r"[^a-z0-9]+",'', s.lower())

def load(t):
    d=json.load(open('/home/heath/mw/v7/tr/%s.json'%t))
    return [w for w in d['words'] if w.get('type')=='word']

UNITS = [
 ('U01', ["Your buyer is in their option period."]),
 ('U02', ["It ends Saturday."]),
 ('U03', ["Friday night, they call you."]),
 ('U04', ["They've changed their mind."]),
 ('U05', ["They want out of the deal."]),
 ('U06', ["So you tell them you'll send the termination notice to the listing agent on Monday."]),
 ('U07', ["It's the weekend."]),
 ('U08', ["Nobody's working anyway."]),
 ('U09', ["That termination notice was due Saturday at 5 p.m. local time where the house is located,",
          "That termination notice was due Saturday at five PM local time where the house is,",
          "That termination notice was due Saturday at 5 p.m. local time where the house is."]),
 ('U10', ["not Monday morning, Saturday at 5.", "not Monday morning, Saturday at five.",
          "Not Monday morning, Saturday at 5."]),
 ('U11', ["And I understand why you'd assume Monday."]),
 ('U12', ["Most deadlines in this contract slide off a weekend.",
          "Most deadlines in the contract slide off a weekend."]),
 ('U13', ["If your buyer's earnest money is due on a Saturday, they get until the end of Monday to deliver it."]),
 ('U14', ["That's written into the contract."]),
 ('U15', ["The termination notice gets none of that."]),
 ('U16', ["There's no weekend language attached to it anywhere.",
          "There is no weekend language attached to it anywhere."]),
 ('U17', ["And the contract is pretty blunt about it.", "And the contract is blunt about it."]),
 ('U18', ["Time is of the essence, strict compliance required."]),
 ('U19', ["So you send that termination notice Monday morning thinking you're fine",
          "So you send that termination notice Monday morning thinking you're fine."]),
 ('U20', ["and your buyer has already lost the right they paid an option fee for.",
          "Your buyer has already lost the right they paid an option fee for."]),
 ('U21', ["Comment option and I'll send you every deadline in this contract with its paragraph",
          "Comment option, and I'll send you every deadline in this contract with its paragraph",
          "Comment option and I'll send you every deadline in the term, in the contract with its paragraph"]),
 ('U22', ["so you know which ones slide off a weekend and which ones don't."]),
]

DISF={'uh','um','er','ah','uhh','umm','mm','hmm','erm'}

def find(ws, phrase, from_idx):
    target=[norm(x) for x in phrase.split() if norm(x)]
    n=len(target)
    for s in range(from_idx, len(ws)-n+1):
        got=[norm(ws[s+k]['text']) for k in range(n)]
        if got==target:
            return s, s+n-1
    return None

out={}
for t in TAKES:
    ws=load(t)
    cur=0; res={}
    for uid, variants in UNITS:
        hit=None
        for v in variants:
            hit=find(ws, v, cur)
            if hit: break
        if not hit:
            print('MISS %s %s'%(t,uid), file=sys.stderr); res[uid]=None; continue
        a,b=hit; cur=b+1
        seg=ws[a:b+1]
        lps=[w.get('logprob',0.0) for w in seg]
        disf=sum(1 for w in seg if norm(w['text']) in DISF)
        dbl=sum(1 for i in range(1,len(seg)) if norm(seg[i-1]['text'])==norm(seg[i]['text']) and norm(seg[i]['text']))
        gaps=[seg[i]['start']-seg[i-1]['end'] for i in range(1,len(seg))]
        res[uid]={'a':a,'b':b,'start':seg[0]['start'],'end':seg[-1]['end'],
                  'dur':round(seg[-1]['end']-seg[0]['start'],3),
                  'n':len(seg),'sumlp':round(sum(lps),4),'minlp':round(min(lps),4),
                  'disf':disf,'dbl':dbl,'maxgap':round(max(gaps),3) if gaps else 0.0,
                  'wps':round(len(seg)/max(0.01,seg[-1]['end']-seg[0]['start']),2),
                  'text':' '.join(w['text'] for w in seg),
                  'gap_before': round(seg[0]['start']-ws[a-1]['end'],3) if a>0 else 0.0,
                  'gap_after': round(ws[b+1]['start']-seg[-1]['end'],3) if b+1<len(ws) else 0.0}
    out[t]=res

json.dump(out, open('/home/heath/mw/v7/units.json','w'), indent=1)

for uid,_ in UNITS:
    r=out[TAKES[2]][uid]
    print('%-5s %s'%(uid, (r['text'][:70] if r else 'MISS')))
    for t in TAKES:
        r=out[t][uid]
        if not r:
            print('      %s MISS'%t[-6:]); continue
        print('      %s dur=%5.2f sumlp=%8.4f minlp=%7.4f maxgap=%.2f wps=%4.1f [%d-%d] @%6.2f gapB=%.2f gapA=%.2f'%(
            t[-6:], r['dur'], r['sumlp'], r['minlp'], r['maxgap'], r['wps'], r['a'], r['b'], r['start'],
            r['gap_before'], r['gap_after']))
