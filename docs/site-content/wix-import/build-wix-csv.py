import os, re, csv, json, sys, io, html as _html, unicodedata
from markdown_it import MarkdownIt

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
BASE = os.path.join(ROOT, 'docs/site-content')
OUT  = os.path.join(BASE, 'wix-import')
SITE = 'https://www.theheathshepardrealestateteam.com'
SKIP = {'INDEX.md', 'NEEDS-VERIFICATION.md'}
os.makedirs(OUT, exist_ok=True)

# ---------------------------------------------------------------- markdown
# Wix Rich Text fields take HTML. The bodies carry GFM tables, nested lists,
# blockquotes and ~850 inline citation links, so this uses a real CommonMark
# parser (markdown-it-py, the reference-compliant port of markdown-it) with the
# GFM table rule on, never regex.
#   html=False      raw HTML in source is escaped, not passed through. The
#                   sources contain none; this keeps it that way.
#   linkify=False   bare URLs are NOT auto-linked. Autolinking would invent
#                   anchors that do not exist in the source and break the
#                   link-count parity check below.
#   typographer=False  no smart quotes / dash substitution. The prose is final;
#                   nothing may silently rewrite a character in it.
MD = MarkdownIt('gfm-like', {'html': False, 'linkify': False,
                             'typographer': False, 'xhtmlOut': False})

_LINK_DEST = re.compile(r'\]\([^)]*\)')
def _escape_underscores(s):
    """Escape every `_` that is not inside a link destination.

    The TREC-form quotations contain literal blank-fill runs, e.g.
    `EXECUTED the ___ day of ___, 20___.`  CommonMark's flanking rules make the
    second and third runs a valid emphasis pair, so a conforming renderer eats
    them and publishes `the ___ day of , 20.` on a legal-content page. That is
    silent corruption of a quoted form, and it is the exact failure this export
    exists to avoid.

    No `_` in this corpus is ever intended as emphasis (all emphasis is written
    with `*`), so escaping them all is lossless and unambiguous. Link
    destinations are skipped because `_` is significant inside a URL."""
    out, last = [], 0
    for m in _LINK_DEST.finditer(s):
        out.append(s[last:m.start()].replace('_', r'\_'))
        out.append(m.group(0))
        last = m.end()
    out.append(s[last:].replace('_', r'\_'))
    return ''.join(out)

def md_to_html(md_src):
    """Markdown body -> HTML for a Wix Rich Text field."""
    return MD.render(_escape_underscores(md_src)).strip()

def _ws(s):
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFC', s)).strip()

# Block tags end a run of text; inline tags do not. Replacing an inline tag with
# a space would invent one mid-word ("<strong>x</strong>." -> "x ."), so the two
# groups are handled separately.
_BLOCK = (r'p|div|h[1-6]|li|ul|ol|table|thead|tbody|tfoot|tr|td|th|blockquote|'
          r'pre|br|hr|section|figure|figcaption|dl|dt|dd')
def html_text(h):
    """Visible text of an HTML fragment, for fidelity comparison."""
    h = re.sub(rf'</?({_BLOCK})(\s[^>]*)?/?>', ' ', h)   # block boundary -> space
    h = re.sub(r'<[^>]*>', '', h)                        # inline tags -> nothing
    return _ws(_html.unescape(h))

def md_text(s):
    """Visible text of a Markdown body: syntax stripped, prose kept.

    Deliberately independent of markdown-it, so it can catch the converter
    dropping or inventing content. Link TARGETS are removed (they are verified
    separately, by href) and list markers are removed (HTML renders those from
    <ol>/<ul>, so they are text on neither side).

    Underscores are left alone on purpose: the TREC-form quotes contain literal
    blank-fill runs ("EXECUTED the ___ day of ___"), which CommonMark does not
    treat as emphasis, so they must survive on both sides identically."""
    s = unicodedata.normalize('NFC', s)
    s = re.sub(r'!?\[([^\]]*)\]\([^)]*\)', r'\1', s)      # [label](target) -> label
    s = re.sub(r'^\s*\|?[\s:|-]*-[\s:|-]*\|[\s:|-]*$', ' ', s, flags=re.M)  # table rule row
    s = re.sub(r'^\s*(-{3,}|\*{3,}|_{3,})\s*$', ' ', s, flags=re.M)         # hr
    s = re.sub(r'^\s*>\s?', ' ', s, flags=re.M)                             # blockquote marker
    # A heading may legitimately BEGIN with "1." ("### 1. Boerne ISD"), so the
    # list-marker strip must not also fire on a heading line.
    s = '\n'.join(re.sub(r'^\s*#{1,6}\s+', ' ', ln) if re.match(r'^\s*#{1,6}\s', ln)
                  else re.sub(r'^\s*([-*+]|\d+[.)])\s+', ' ', ln)
                  for ln in s.split('\n'))
    s = s.replace('|', ' ')                                                 # table cell pipes
    s = re.sub(r'\*\*(.+?)\*\*', r'\1', s, flags=re.S)                      # bold
    s = re.sub(r'(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)', r'\1', s, flags=re.S)  # italic
    s = s.replace('`', '')
    return _ws(s)

def html_links(h):
    """Every href in an HTML fragment, unescaped."""
    return [_html.unescape(m) for m in re.findall(r'href="([^"]*)"', h)]

gaps = []          # (collection, field, item, reason)
BODY_MD = {}       # (collection, slug) -> markdown body, kept for verification
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
    gmd = strip_h1(body); BODY_MD[('BoerneGuides', slug)] = gmd
    guide_rows.append({
        'title': d['h1'], 'slug': slug,
        'metaTitle': d['title'], 'metaDescription': d['meta_description'],
        'summary': '', 'body': md_to_html(gmd),
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

    nmd = strip_h1(body); BODY_MD[('Neighborhoods', slug)] = nmd
    neigh_rows.append({
        'name': d['neighborhood_name'], 'slug': slug,
        'metaTitle': d['title'], 'metaDescription': d['meta_description'],
        'summary': '', 'body': md_to_html(nmd),
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

    BODY_MD[('Answers', slug)] = b
    gnum = SLUG_TO_GUIDE.get(slug) or CATEGORY_TO_GUIDE[d['category']]
    gslug, gh1, _ = GUIDE_BY_NUM[gnum]
    ans_rows.append({
        'question': d['question'], 'slug': slug,
        'metaTitle': d['question'], 'metaDescription': d['meta_description'],
        'shortAnswer': d['short_answer'], 'body': md_to_html(b),
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

# ---- second pass: the Markdown -> HTML conversion must lose nothing
# Re-read every body OUT OF THE WRITTEN CSV (not from memory) and check it
# against the Markdown it came from. Three independent checks.
CSV_FOR = {'BoerneGuides': 'BoerneGuides.csv', 'Neighborhoods': 'Neighborhoods.csv',
           'Answers': 'Answers.csv'}
SLUGS   = {c: {r['slug'] for r in rows}
           for c, rows in (('BoerneGuides', guide_rows), ('Neighborhoods', neigh_rows),
                           ('Answers', ans_rows))}
PREFIX  = {'/boerne/': 'BoerneGuides', '/neighborhoods/': 'Neighborhoods',
           '/answers/': 'Answers'}

fail, n_links, n_internal, n_block = 0, 0, 0, 0
for coll, fname in CSV_FOR.items():
    with open(os.path.join(OUT, fname), encoding='utf-8', newline='') as fh:
        for r in csv.DictReader(fh):
            slug, h = r['slug'], r['body']
            src = BODY_MD[(coll, slug)]

            # (a) every link survives, in the same order, with the same target
            src_links = [m for m in re.findall(r'\]\(([^)\s]+)\)', src)]
            got_links = html_links(h)
            if src_links != got_links:
                lost = [l for l in src_links if l not in got_links]
                extra = [l for l in got_links if l not in src_links]
                print(f'LINK MISMATCH {coll}/{slug}: -{lost[:3]} +{extra[:3]}'); fail += 1
            n_links += len(got_links)

            # (b) every internal link resolves to a slug that exists in this export
            for l in got_links:
                if not l.startswith('/'):
                    continue
                n_internal += 1
                pre = next((p for p in PREFIX if l.startswith(p)), None)
                tgt = l[len(pre):].split('#')[0].rstrip('/') if pre else None
                if not pre or tgt not in SLUGS[PREFIX[pre]]:
                    print(f'DEAD INTERNAL LINK {coll}/{slug} -> {l}'); fail += 1

            # (c) the visible text is the source text: no prose dropped, none added
            if html_text(h) != md_text(src):
                a, b = html_text(h), md_text(src)
                i = next((j for j in range(min(len(a), len(b))) if a[j] != b[j]), min(len(a), len(b)))
                print(f'TEXT DRIFT {coll}/{slug} @{i}\n  html: {a[max(0,i-60):i+60]!r}'
                      f'\n  md  : {b[max(0,i-60):i+60]!r}'); fail += 1

            # (d) block-level structure actually converted (no literal markdown left)
            for pat, why in ((r'^\s*#{1,6}\s', 'literal heading'),
                             (r'^\s*\|', 'literal table row'),
                             (r'\*\*', 'literal bold')):
                if re.search(pat, h, re.M):
                    print(f'UNCONVERTED {coll}/{slug}: {why}'); fail += 1
            n_block += len(re.findall(r'<(h[2-6]|table|ul|ol|blockquote)\b', h))

print(f'\nhtml check: {n_links} links preserved ({n_internal} internal, all resolving), '
      f'{n_block} block elements, {"OK" if fail == 0 else str(fail) + " FAILURES"}')
if fail:
    raise SystemExit('HTML conversion verification FAILED')

# ------------------------------------------------------------------ gaps
with open(os.path.join(OUT, '.gaps.json'), 'w') as fh: json.dump(gaps, fh)
agg = {}
for c,f,i,r in gaps: agg.setdefault((c,f), []).append((i,r))
print('\n--- fields not populated from source ---')
for (c,f),v in sorted(agg.items()):
    print(f'{c:15s} {f:32s} {len(v):3d} items')
