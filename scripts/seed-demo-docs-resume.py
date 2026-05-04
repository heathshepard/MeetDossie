"""Resume only the deals that didn't finish on the first pass (rate limit hit).

Imports the first script as a module so we don't duplicate the DEALS spec, but
filters to the dossier numbers passed on argv.
"""
import sys
import os
from pathlib import Path

# Make the sibling script importable.
HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

import importlib.util
spec = importlib.util.spec_from_file_location("seeder", str(HERE / "seed-demo-docs.py"))
seeder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seeder)

import tempfile

# Hard-coded list of dossiers to retry (set 5 and 6 from the first run).
RETRY_DOSSIERS = {"DEMO-2026-005", "DEMO-2026-006"}

def main():
    out_dir = Path(tempfile.mkdtemp(prefix="dossie-demo-pdfs-resume-"))
    print(f"[gen] writing PDFs to {out_dir}")

    # Filter the DEALS dict before calling generate_pdfs.
    full_deals = seeder.DEALS
    filtered = {k: v for k, v in full_deals.items() if k in RETRY_DOSSIERS}
    seeder.DEALS = filtered
    plan = seeder.generate_pdfs(out_dir)
    seeder.DEALS = full_deals  # restore (not strictly needed)
    print(f"[gen] {len(plan)} PDFs written")

    token = seeder.sign_in()
    print(f"[auth] signed in (token len {len(token)})")

    ok = 0
    fail = 0
    for item in plan:
        status, body = seeder.upload(token, item)
        if 200 <= status < 300:
            ok += 1
            print(f"  OK  {item['dossier']} {item['filename']}")
        else:
            fail += 1
            print(f"  FAIL {item['dossier']} {item['filename']} -> {status} {body}")
    print(f"[done] uploaded={ok} failed={fail} of {len(plan)}")

    for item in plan:
        try: os.remove(item["path"])
        except OSError: pass
    try: out_dir.rmdir()
    except OSError: pass

    return 0 if fail == 0 else 1

if __name__ == "__main__":
    sys.exit(main())
