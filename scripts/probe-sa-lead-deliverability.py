"""
Pierce dry-run — deliverability probe on a 50-lead balanced sample.

Approach:
  1. Balanced sample: 5 leads per top-10 brokerage (or as many as available).
  2. For each: MX lookup on the domain (already done in enrichment, re-verify).
  3. Lightweight SMTP handshake — connect to MX, HELO, then MAIL FROM/RCPT TO
     with an immediate QUIT. Records the response code without sending
     data. This catches domains that outright refuse, but many providers
     (Gmail, Google Workspace) accept-all at RCPT TO and reject later, so
     result is directional not definitive.
  4. Writes results to data/sa-realtor-deliverability-probe.csv.

Real send test is NOT done here — Pierce doesn't send from this script per
the "do NOT actually send" constraint. That's done by the batched Resend
payload after Heath's green light.
"""
import csv
import smtplib
import socket
import time
from collections import defaultdict

try:
    import dns.resolver
except ImportError:
    raise SystemExit("dnspython not installed. Run: python -m pip install dnspython")

SRC = r"C:\Users\Heath Shepard\Desktop\MeetDossie\data\sa-realtor-leads-final-v2.csv"
DST = r"C:\Users\Heath Shepard\Desktop\MeetDossie\data\sa-realtor-deliverability-probe.csv"
FROM_ADDRESS = "heath@meetdossie.com"

# Providers that famously accept-all at RCPT TO (result unreliable).
ACCEPT_ALL_PROVIDERS = {
    "aspmx.l.google.com.",
    "gmail-smtp-in.l.google.com.",
    "smtp.google.com.",
    "outlook.com.",
    "mimecast.com.",
    "protection.outlook.com.",
    "securence.com.",
}


def mx_lookup(domain: str):
    resolver = dns.resolver.Resolver()
    resolver.timeout = 4
    resolver.lifetime = 6
    try:
        answers = resolver.resolve(domain, "MX")
        recs = sorted([(a.preference, str(a.exchange)) for a in answers])
        return recs
    except Exception as e:
        return [("ERROR", type(e).__name__)]


def probe_recipient(email: str, mx_host: str, timeout=8):
    """Lightweight SMTP handshake. Returns (code, message)."""
    try:
        with smtplib.SMTP(mx_host, 25, timeout=timeout) as s:
            s.ehlo("meetdossie.com")
            code, msg = s.mail(FROM_ADDRESS)
            if code >= 400:
                return ("mail_from_reject", f"{code} {msg.decode(errors='ignore')[:60]}")
            code, msg = s.rcpt(email)
            s.quit()
            msg_str = msg.decode(errors="ignore")[:80] if isinstance(msg, bytes) else str(msg)[:80]
            return (str(code), msg_str)
    except socket.timeout:
        return ("timeout", "SMTP connection timed out")
    except (ConnectionRefusedError, OSError) as e:
        return ("conn_error", type(e).__name__)
    except Exception as e:
        return ("probe_error", f"{type(e).__name__}: {str(e)[:60]}")


def is_accept_all(mx_host: str) -> bool:
    for provider in ACCEPT_ALL_PROVIDERS:
        if provider in mx_host.lower():
            return True
    return False


def main():
    with open(SRC, "r", encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))

    # Only pattern-guessed emails (skip existing + skips)
    populated = [
        r for r in rows
        if r.get("email_source", "").startswith("pattern_guess:")
    ]
    print(f"Total pattern-guessed emails available: {len(populated)}")

    # Group by brokerage, pick top 10, up to 5 per brokerage
    by_broker = defaultdict(list)
    for r in populated:
        by_broker[r["brokerage"].strip()].append(r)

    top10 = sorted(by_broker.items(), key=lambda x: -len(x[1]))[:10]
    sample = []
    for broker, rs in top10:
        sample.extend(rs[:5])
    print(f"Balanced sample size: {len(sample)}  (top 10 brokerages, up to 5 each)")

    # Cache MX per domain
    mx_cache = {}
    results = []
    for i, row in enumerate(sample, 1):
        email = row["email"]
        domain = email.split("@")[1]
        if domain not in mx_cache:
            mx_cache[domain] = mx_lookup(domain)
        mx = mx_cache[domain]
        top_mx = mx[0][1] if mx and mx[0][0] != "ERROR" else "(no MX)"

        if mx[0][0] == "ERROR":
            code, note = "no_mx", mx[0][1]
        elif is_accept_all(top_mx):
            # Skip probe — result would be misleading
            code, note = "accept_all", f"provider={top_mx}"
        else:
            code, note = probe_recipient(email, top_mx)

        results.append({
            "email": email,
            "name": row["name"],
            "brokerage": row["brokerage"],
            "domain": domain,
            "mx_host": top_mx,
            "probe_code": code,
            "probe_note": note,
        })
        print(f"  {i:2d}. {email:45s} {code:12s} {note[:40]}")
        # Rate-limit: 1 probe per second to avoid tripping anti-abuse
        time.sleep(1)

    with open(DST, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(results[0].keys()))
        w.writeheader()
        w.writerows(results)

    # Summary
    summary = defaultdict(int)
    for r in results:
        summary[r["probe_code"]] += 1
    print("\n=== Deliverability probe summary ===")
    for k, v in sorted(summary.items(), key=lambda x: -x[1]):
        print(f"  {k}: {v}")
    print(f"\nWrote: {DST}")


if __name__ == "__main__":
    main()
