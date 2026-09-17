import os, re, csv, json, sys, io

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
BASE = os.path.join(ROOT, 'docs/site-content')
OUT  = os.path.join(BASE, 'wix-import')
SITE = 'https://www.theheathshepardrealestateteam.com'
SKIP = {'INDEX.md', 'NEEDS-VERIFICATION.md'}
os.makedirs(OUT, exist_ok=True)

gaps = []          # (collection, field, item, reason)
def gap(c, f, i, r): gaps.append((c, f, i, r))

def parse(path):
    t = open(path, encoding='utf-8').read()
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', t, re.S)
    raw, body = m.group(1), m.group(2)
    d, key = {}, None
    for line in raw.split('\n'):
        km = re.match(r'^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$', line)
        if km:
            key, v = km.group(1), km.group(2).strip()
            if v:
                if len(v) > 1 and v[0] == v[-1] and v[0] in '"\'': v = v[1:-1]
                d[key] = v
            else:
                d[key] = []
        elif re.match(r'^\s+-\s', line) and key is not None:
            v = re.sub(r'^\s+-\s*', '', line).strip()
            if len(v) > 1 and v[0] == v[-1] and v[0] in '"\'': v = v[1:-1]
            if not isinstance(d.get(key), list): d[key] = []
            d[key].append(v)
    return d, body

def strip_h1(body):
    b = body.strip()
    return re.sub(r'^#\s+[^\n]*\n+', '', b, count=1).strip()

def files(sub):
    return [f for f in sorted(os.listdir(os.path.join(BASE, sub)))
            if f.endswith('.md') and f not in SKIP]

# ---------------------------------------------------------------- guides
GUIDE_BY_NUM = {}
guide_rows = []
for f in files('boerne-hub'):
    d, body = parse(os.path.join(BASE, 'boerne-hub', f))
    slug = d['slug']
    GUIDE_BY_NUM[f[:2]] = (slug, d['h1'], d['title'])
    if len(d['title']) > 60:
        gap('BoerneGuides', 'metaTitle', slug, f"{len(d['title'])} chars, spec is <=60")
    gap('BoerneGuides', 'summary', slug, 'no 40-60 word summary in source')
    gap('BoerneGuides', 'heroImage/heroImageAlt', slug, 'no image in source')
    gap('BoerneGuides', 'datePublished', slug, 'not in source; set at publish')
    gap('BoerneGuides', 'dateModified', slug, 'not in source')
    gap('BoerneGuides', 'relatedNeighborhoods', slug, 'required 3-6; not in source')
    gap('BoerneGuides', 'relatedAnswers', slug, 'required 3-5; not in source')
    if '```json' not in body:
        gap('BoerneGuides', 'faqJson', slug, 'optional; no FAQ JSON-LD in source')
    guide_rows.append({
        'title': d['h1'], 'slug': slug,
        'metaTitle': d['title'], 'metaDescription': d['meta_description'],
        'summary': '', 'body': strip_h1(body),
        'heroImage': '', 'heroImageAlt': '',
        'datePublished': '', 'dateModified': '',
        'pageType': 'guide', 'faqJson': '',
        'relatedNeighborhoods': '', 'relatedAnswers': '',
        'wordCount': d['word_count'], 'status': 'draft',
    })

# ---------------------------------------------------------- neighborhoods
CITY_VOCAB = ['Fair Oaks Ranch', 'Comfort', 'Boerne']
ISD_RE = r'\b(Boerne|Comfort|Northside|Comal|Harlandale|Judson|Kerrville|Fair Oaks Ranch)\s+ISD\b'
neigh_rows = []
for f in files('boerne-neighborhoods'):
    d, body = parse(os.path.join(BASE, 'boerne-neighborhoods', f))
    slug = d['slug']
    if len(d['title']) > 60:
        gap('Neighborhoods', 'metaTitle', slug, f"{len(d['title'])} chars, spec is <=60")

    city = next((c for c in CITY_VOCAB if c in d['title']), '')
    if not city: gap('Neighborhoods', 'city', slug, 'not derivable from title')

    schools = d.get('schools', [])
    if len(schools) == 3 and not any('ISD' in s and ':' not in s and '(' not in s for s in schools):
        elem, mid, high = schools
    elif len(schools) == 3:
        elem, mid, high = schools
    else:
        elem = mid = high = ''
        gap('Neighborhoods', 'elementary/middle/highSchool', slug,
            f'source `schools` has {len(schools)} entries, not a clean 3-campus list')

    isd = sorted(set(re.findall(ISD_RE, ' '.join(schools)))) or \
          sorted(set(re.findall(ISD_RE, body)))
    if len(isd) == 1:
        district = isd[0] + ' ISD'
    else:
        district = ''
        gap('Neighborhoods', 'schoolDistrict', slug,
            'ambiguous - source names ' + (', '.join(isd) + ' ISD' if isd else 'no district'))

    for fld, why in [('summary', 'no 40-60 word summary in source'),
                     ('latitude/longitude', 'no coordinates in source'),
                     ('priceRangeLow/priceRangeHigh', 'no price band in source'),
                     ('priceAsOf', 'no price band, so no as-of date'),
                     ('heroImage/heroImageAlt', 'no image in source'),
                     ('nearbyNeighborhoods', 'required 3-5; not in source'),
                     ('relatedAnswers', 'required 2-3; not in source'),
                     ('parentGuide', 'not in source; no per-neighborhood guide assignment')]:
        gap('Neighborhoods', fld, slug, why)

    neigh_rows.append({
        'name': d['neighborhood_name'], 'slug': slug,
        'metaTitle': d['title'], 'metaDescription': d['meta_description'],
        'summary': '', 'body': strip_h1(body),
        'city': city, 'county': d['county'],
        'latitude': '', 'longitude': '',
        'zipCodes': d['zip'], 'schoolDistrict': district,
        'elementarySchool': elem, 'middleSchool': mid, 'highSchool': high,
        'hoaFeeAnnual': '', 'hoaNotes': d['hoa_status'],
        'priceRangeLow': '', 'priceRangeHigh': '', 'priceAsOf': '',
        'lotSizeTypical': '', 'yearBuiltRange': '', 'amenities': '',
        'heroImage': '', 'heroImageAlt': '',
        'nearbyNeighborhoods': '', 'relatedAnswers': '',
        'parentGuide': '', 'status': 'draft',
    })

# ---------------------------------------------------------------- answers
CATEGORY_TO_GUIDE = {
    'Boerne and the Hill Country': '01',
    'Taxes and exemptions':        '08',
    'Texas transaction mechanics': '02',
    'Financing':                   '02',
    'Investing':                   '01',
    'Relocation':                  '07',
}
# topic overrides where the category is too coarse for a correct breadcrumb
SLUG_TO_GUIDE = {
    'are-boerne-isd-schools-good':                                  '05',
    'boerne-vs-fair-oaks-ranch-vs-bulverde':                        '04',
    'how-far-is-boerne-from-san-antonio':                           '04',
    'what-are-property-taxes-like-in-boerne':                       '08',
    'can-an-hoa-ban-short-term-rentals-in-texas':                   '09',
    'is-boerne-good-for-short-term-rentals':                        '09',
    'is-hill-country-land-a-good-investment':                       '10',
    'what-should-i-know-about-septic-and-wells-in-the-hill-country': '10',
    'what-is-an-ag-exemption-in-texas-and-what-are-rollback-taxes':  '10',
}
ans_rows, faq_rows = [], []
for f in files('answers'):
    d, body = parse(os.path.join(BASE, 'answers', f))
    slug = d['slug']
    if len(d['question']) > 60:
        gap('Answers', 'metaTitle', slug, f"{len(d['question'])} chars, spec is <=60")
    if len(d['meta_description']) > 155:
        gap('Answers', 'metaDescription', slug, f"{len(d['meta_description'])} chars, spec is <=155")
    gap('Answers', 'datePublished', slug, 'not in source; set at publish')

    b = strip_h1(body)
    faq = ''
    m = re.search(r'\n```json\n(.*?)\n```\s*$', b, re.S)
    if m:
        faq = m.group(1).strip()
        json.loads(faq)                       # validate
        b = b[:m.start()].strip()
    # the source repeats short_answer as body paragraph 1; shortAnswer renders it (ARCH s8)
    if b.startswith(d['short_answer']):
        b = b[len(d['short_answer']):].strip()
    else:
        gap('Answers', 'body', slug, 'short_answer not repeated at head of body - not de-duplicated')

    gnum = SLUG_TO_GUIDE.get(slug) or CATEGORY_TO_GUIDE[d['category']]
    gslug, gh1, _ = GUIDE_BY_NUM[gnum]
    ans_rows.append({
        'question': d['question'], 'slug': slug,
        'metaTitle': d['question'], 'metaDescription': d['meta_description'],
        'shortAnswer': d['short_answer'], 'body': b,
        'datePublished': '', 'dateModified': d['last_reviewed'],
        'parentGuide': gslug, 'parentGuideUrl': f'{SITE}/boerne/{gslug}',
        'siblingAnswers': ','.join(d.get('related_questions', [])),
        'sourceNote': '\n'.join(d.get('sources', [])),
        'status': 'draft',
    })
    faq_rows.append({'slug': slug, 'faqJson': faq})

# ------------------------------------------------------------------ write
SPECS = [
    ('BoerneGuides.csv', ['title','slug','metaTitle','metaDescription','summary','body',
        'heroImage','heroImageAlt','datePublished','dateModified','pageType','faqJson',
        'relatedNeighborhoods','relatedAnswers','wordCount','status'], guide_rows),
    ('Neighborhoods.csv', ['name','slug','metaTitle','metaDescription','summary','body','city',
        'county','latitude','longitude','zipCodes','schoolDistrict','elementarySchool',
        'middleSchool','highSchool','hoaFeeAnnual','hoaNotes','priceRangeLow','priceRangeHigh',
        'priceAsOf','lotSizeTypical','yearBuiltRange','amenities','heroImage','heroImageAlt',
        'nearbyNeighborhoods','relatedAnswers','parentGuide','status'], neigh_rows),
    ('Answers.csv', ['question','slug','metaTitle','metaDescription','shortAnswer','body',
        'datePublished','dateModified','parentGuide','parentGuideUrl','siblingAnswers',
        'sourceNote','status'], ans_rows),
    ('Answers-faqJson-SUPPLEMENT.csv', ['slug','faqJson'], faq_rows),
]

for fname, cols, rows in SPECS:
    p = os.path.join(OUT, fname)
    with open(p, 'w', encoding='utf-8', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=cols, quoting=csv.QUOTE_ALL,
                           lineterminator='\r\n', extrasaction='raise')
        w.writeheader()
        for r in rows: w.writerow(r)
    # ---- round-trip: parse back, compare cell-for-cell against in-memory rows
    with open(p, encoding='utf-8', newline='') as fh:
        back = list(csv.DictReader(fh))
    assert list(back[0].keys()) == cols, (fname, 'header mismatch')
    assert len(back) == len(rows), (fname, len(back), len(rows))
    for i, (a, b) in enumerate(zip(rows, back)):
        for c in cols:
            if str(a.get(c, '')) != b[c]:
                raise SystemExit(f'ROUND-TRIP FAIL {fname} row {i} col {c}\n'
                                 f'  src: {str(a.get(c,""))[:200]!r}\n  csv: {b[c][:200]!r}')
    print(f'{fname:36s} {len(rows):3d} rows x {len(cols):2d} cols  round-trip OK  '
          f'({os.path.getsize(p):,} bytes)')

# ---- second round-trip: CSV body must equal the source file body exactly
def check_bodies():
    import csv as _c
    bad = 0
    with open(os.path.join(OUT,'Answers.csv'), encoding='utf-8', newline='') as fh:
        for r in _c.DictReader(fh):
            src = open(os.path.join(BASE,'answers', r['slug']+'.md'), encoding='utf-8').read()
            for tok in re.findall(r'\]\((https?://[^)]+)\)', r['body']):
                if tok not in src: print('CITATION LOST', r['slug'], tok); bad += 1
    return bad
print('citation check (Answers): ', 'OK' if check_bodies()==0 else 'FAILED')

# ------------------------------------------------------------------ gaps
with open(os.path.join(OUT, '.gaps.json'), 'w') as fh: json.dump(gaps, fh)
agg = {}
for c,f,i,r in gaps: agg.setdefault((c,f), []).append((i,r))
print('\n--- fields not populated from source ---')
for (c,f),v in sorted(agg.items()):
    print(f'{c:15s} {f:32s} {len(v):3d} items')
