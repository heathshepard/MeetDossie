"""
Sanity test for validate_capability_beat() in produce-skits.py.

Runs three checks:
  1. Rewritten SKIT_PARADISE.lines passes validation
  2. Rewritten SKIT_BREAKUP.lines passes validation
  3. Fabricated bad script with banned phrase + no capability beat FAILS

Exit 0 on all-pass, 1 on any failure.
"""

import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location("produce_skits", HERE / "produce-skits.py")
ps = importlib.util.module_from_spec(spec)
# Skip __main__ execution by guarding the module load
try:
    spec.loader.exec_module(ps)
except SystemExit:
    pass


def check(name, fn):
    try:
        fn()
        print(f"  PASS: {name}")
        return True
    except AssertionError as e:
        print(f"  FAIL: {name} -> {e}")
        return False
    except Exception as e:
        print(f"  ERROR: {name} -> {type(e).__name__}: {e}")
        return False


results = []

def test_paradise_passes():
    result = ps.validate_capability_beat(ps.SKIT_PARADISE["lines"])
    assert result["verb"] in ps.CAPABILITY_VERBS, f"unexpected verb {result['verb']}"
    assert "dossie" in result["text"].lower(), "matched line missing Dossie"
    print(f"    SKIT_PARADISE verb={result['verb']!r} line_index={result['line_index']}")

def test_breakup_passes():
    result = ps.validate_capability_beat(ps.SKIT_BREAKUP["lines"])
    assert result["verb"] in ps.CAPABILITY_VERBS, f"unexpected verb {result['verb']}"
    assert "dossie" in result["text"].lower(), "matched line missing Dossie"
    print(f"    SKIT_BREAKUP verb={result['verb']!r} line_index={result['line_index']}")

def test_bad_script_fails():
    bad = [
        ("charlie", "stuff"),
        ("bill",    "Meet Dossie."),
        ("bill",    "Texas agents - meetdossie.com slash founding"),
    ]
    try:
        ps.validate_capability_beat(bad)
    except ValueError as e:
        print(f"    Bad script correctly rejected: {str(e)[:120]}...")
        return
    raise AssertionError("Bad script with banned phrase 'Meet Dossie' should have failed")

results.append(check("SKIT_PARADISE passes capability beat", test_paradise_passes))
results.append(check("SKIT_BREAKUP passes capability beat", test_breakup_passes))
results.append(check("Bad script with banned phrase fails", test_bad_script_fails))

if all(results):
    print("\nALL PYTHON TESTS PASSED")
    sys.exit(0)
else:
    print("\nSOME PYTHON TESTS FAILED")
    sys.exit(1)
