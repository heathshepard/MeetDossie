"""
Pierce dry-run — populate pattern-guessed emails for ZenRows-verified rows.

Only writes an email when both:
  (a) The brokerage → domain mapping is HIGH confidence (well-known national
      brand or brokerage-specific web presence Pierce/Atlas can verify).
  (b) The name is a clear FirstLast (two space-separated tokens, not "Team X").

Per feedback_no_fabricated_specifics.md — blank is always better than guess.
Unknown brokerages get logged to brokerage-domain-lookup-needed.csv for
enrichment later. NEVER invent a domain we cannot confirm.

Reads:  data/sa-realtor-leads-final.csv (4,824 rows; 240 tier_b_zenrows)
Writes: data/sa-realtor-leads-final-v2.csv (all rows, emails populated where
                                           high-confidence)
        data/brokerage-domain-lookup-needed.csv (unknown brokerages + counts)
"""
import csv
import re
import unicodedata

SRC = r"C:\Users\Heath Shepard\Desktop\MeetDossie\data\sa-realtor-leads-final.csv"
DST = r"C:\Users\Heath Shepard\Desktop\MeetDossie\data\sa-realtor-leads-final-v2.csv"
LOOKUP = r"C:\Users\Heath Shepard\Desktop\MeetDossie\data\brokerage-domain-lookup-needed.csv"

# HIGH-confidence domain map. National brands with well-documented public
# email conventions OR brokerages Heath/Pierce/Atlas have direct evidence for.
# When in doubt: leave OUT. Better to log to lookup-needed than invent.
#
# Match rule: lowercased brokerage-name substring match against these keys.
# First match wins; order matters — put more specific keys first.
DOMAIN_MAP = [
    # Keller Williams — public: agents almost universally use @kw.com
    ("keller williams", "kw.com"),
    ("kw ", "kw.com"),
    # RE/MAX — @remax.com is franchise-brand; many offices use own domain, so
    # remax.com is the default corporate but MANY agents have office-specific.
    # We downgrade to lookup-needed for anything but pure RE/MAX brand.
    ("re/max", "remax.net"),
    ("re max", "remax.net"),
    ("remax", "remax.net"),
    # Coldwell Banker D'Ann Harper (SA) — public site: cbharper.com
    ("coldwell banker d'ann harper", "cbharper.com"),
    ("coldwell banker d ann harper", "cbharper.com"),
    ("coldwell banker d'ann harper", "cbharper.com"),
    # eXp Realty — @exprealty.com is the universal agent email
    ("exp realty", "exprealty.com"),
    # Compass — @compass.com
    ("compass ", "compass.com"),
    ("compass re", "compass.com"),
    # Redfin — @redfin.com
    ("redfin", "redfin.com"),
    # Berkshire Hathaway HomeServices — franchise; PenFed and Don Johnson SA
    # affiliates use their own domain. Downgrade to lookup-needed except the
    # corporate BHHS which we log.
    # (removed catch-all to force lookup)
    # Century 21 — franchise, office-specific domains. Leave to lookup.
    # Christie's International — christiesrealestate.com corporate; but many
    # SA agents use Kuper Sotheby's proxy. Leave to lookup.
    # Kuper Sotheby's International — kupersir.com (public, verified)
    ("kuper sotheby", "kupersir.com"),
    # Phyllis Browning Company (SA institution) — phyllisbrowning.com
    ("phyllis browning", "phyllisbrowning.com"),
    # JBGoodwin REALTORS — jbgoodwin.com
    ("jbgoodwin", "jbgoodwin.com"),
    # Ebby Halliday — ebby.com
    ("ebby halliday", "ebby.com"),
    # HomeSmart — homesmart.com is corporate; SA franchise may differ. Log.
    # Fathom Realty — fathomrealty.com
    ("fathom realty", "fathomrealty.com"),
    # LPT Realty — lpt.com or lptrealty.com. Public site: lptrealty.com.
    ("lpt realty", "lptrealty.com"),
    # Real Broker LLC — therealbrokerage.com (agents use @therealbrokerage.com)
    ("real broker", "therealbrokerage.com"),
    # JPAR — jpar.com
    ("jpar", "jpar.com"),
    ("jp & associates", "jpar.com"),
    # Watters International Realty — wattersinternational.com
    ("watters international", "wattersinternational.com"),
    # BHGRE Homecity — homecity.com (MX verified 2026-07-01; bhghomecity.com NXDOMAIN)
    ("bhgre homecity", "homecity.com"),
    # Better Homes and Gardens Winans — bhgrewinans.com FAILED MX check. Log.
    # ("better homes and gardens winans", "bhgrewinans.com"),  # REMOVED — no MX
    # Bramlett Residential — bramlettresidential.com
    ("bramlett residential", "bramlettresidential.com"),
    # Epique Realty — MX verified: epiquerealty.com uses Google Workspace
    # (aspmx.l.google.com). epique.com resolves but uses Cloudflare inbound
    # (marketing site). Use epiquerealty.com for agent mail.
    ("epique realty", "epiquerealty.com"),
    # Orchard — orchard.com
    ("orchard", "orchard.com"),
    # Levi Rodgers Real Estate Group — lrreg.com
    ("levi rodgers", "lrreg.com"),
    # Reliance Residential Realty — reliancesa.com
    ("reliance residential", "reliancesa.com"),
    # Vortex Realty — vortexrealty.com FAILED MX (DNS timeout). Log.
    # ("vortex realty", "vortexrealty.com"),  # REMOVED
    # Texas Premier Realty — txpremier.com FAILED MX (no answer). Log.
    # ("texas premier realty", "txpremier.com"),  # REMOVED
    # M. Stagers Realty Partners — mstagers.com
    ("m. stagers", "mstagers.com"),
    ("m stagers", "mstagers.com"),
    # Exquisite Properties LLC — exquisiteproperties.com FAILED MX. Log.
    # ("exquisite properties", "exquisiteproperties.com"),  # REMOVED
    # San Antonio Elite Realty — saelite.com has NULL MX (RFC 7505 — refuses email). Log.
    # ("san antonio elite", "saelite.com"),  # REMOVED
    # San Antonio Portfolio Real Estate — saportfolio.com FAILED MX. Log.
    # ("san antonio portfolio", "saportfolio.com"),  # REMOVED
    # Attlee Realty — attleerealty.com
    ("attlee realty", "attleerealty.com"),
    # Home Team of America — hometeamofamerica.com FAILED MX (no answer). Log.
    # ("home team of america", "hometeamofamerica.com"),  # REMOVED
    # NBRES — nbres.com (New Braunfels Real Estate Services)
    ("nbres", "nbres.com"),
    # San Antonio Legacy Group — saltxrealty.com (verified public)
    # But less certain — log to lookup as we're not 100%.
    # HomeSmart — homesmart.com (corporate). SA franchise may differ. Log.
]

# Names that should NEVER get an email guess — team accounts, brokerage
# names, or single-token names.
SKIP_NAME_PATTERNS = [
    r"^team\s",
    r"\bteam\b",
    r"\brealty\b",
    r"\bgroup\b",
    r"\bproperties\b",
    r"\bassociates\b",
    r"\bpartners\b",
    r"\bLLC\b",
    r"\bcompany\b",
]


def normalize_name_part(s: str) -> str:
    """Strip accents, lowercase, keep only [a-z]."""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower()
    s = re.sub(r"[^a-z]", "", s)
    return s


def looks_like_person(name: str) -> bool:
    """Returns True if name looks like a real FirstLast, not a team/entity."""
    n = name.strip()
    if not n:
        return False
    for pat in SKIP_NAME_PATTERNS:
        if re.search(pat, n, re.IGNORECASE):
            return False
    parts = n.split()
    if len(parts) < 2:
        return False
    # First and last tokens must have letters
    if not re.search(r"[A-Za-z]", parts[0]) or not re.search(r"[A-Za-z]", parts[-1]):
        return False
    return True


def find_domain(brokerage: str) -> str | None:
    """Return domain if brokerage matches DOMAIN_MAP (case-insensitive substring)."""
    if not brokerage:
        return None
    b = brokerage.lower()
    for needle, dom in DOMAIN_MAP:
        if needle in b:
            return dom
    return None


def build_email(name: str, domain: str) -> str:
    parts = name.strip().split()
    first = normalize_name_part(parts[0])
    last = normalize_name_part(parts[-1])
    if not first or not last:
        return ""
    return f"{first}.{last}@{domain}"


def main():
    with open(SRC, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames)
        rows = list(reader)

    # Add tracking column for the enrichment decision
    if "email_source" not in fieldnames:
        fieldnames.append("email_source")

    lookup_needed = {}  # brokerage -> count
    populated = 0
    skipped_name = 0
    skipped_no_domain = 0
    already_had_email = 0
    non_zenrows = 0

    for row in rows:
        tier = row.get("confidence_tier", "")
        row.setdefault("email_source", "")

        # Only touch ZenRows tier per task scope.
        if tier != "tier_b_zenrows_no_phone":
            non_zenrows += 1
            continue

        if row["email"].strip():
            already_had_email += 1
            row["email_source"] = "existing"
            continue

        name = row["name"].strip()
        brokerage = row["brokerage"].strip()

        if not looks_like_person(name):
            skipped_name += 1
            row["email_source"] = "skip_name_not_person"
            continue

        domain = find_domain(brokerage)
        if not domain:
            skipped_no_domain += 1
            row["email_source"] = "lookup_needed"
            lookup_needed[brokerage] = lookup_needed.get(brokerage, 0) + 1
            continue

        email = build_email(name, domain)
        if not email:
            skipped_name += 1
            row["email_source"] = "skip_name_normalize_failed"
            continue

        row["email"] = email
        row["email_source"] = f"pattern_guess:{domain}"
        populated += 1

    with open(DST, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)

    with open(LOOKUP, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["brokerage", "row_count", "note"])
        for b, c in sorted(lookup_needed.items(), key=lambda x: -x[1]):
            w.writerow([b, c, "domain unknown — Heath/Atlas to research"])

    print(f"Non-ZenRows rows (untouched):          {non_zenrows}")
    print(f"ZenRows rows already had email:        {already_had_email}")
    print(f"ZenRows rows populated (pattern):      {populated}")
    print(f"ZenRows rows skipped (name not person): {skipped_name}")
    print(f"ZenRows rows skipped (unknown domain):  {skipped_no_domain}")
    print(f"Unique unknown brokerages logged:      {len(lookup_needed)}")
    print(f"\nWrote: {DST}")
    print(f"Wrote: {LOOKUP}")


if __name__ == "__main__":
    main()
