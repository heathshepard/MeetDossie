#!/usr/bin/env python3
"""Emit the beat-join timestamps of a headless build for check-join-audibility.js.

    python3 scripts/headless-video/joins_from_build.py specs/<name>.json > joins.json
    node scripts/video-engine/check-join-audibility.js \
        --audio /home/heath/mw/headless/<slug>/voice.wav --joins joins.json

A headless render has no multi-take splices, but it DOES have one audio join per
beat boundary: each beat is a separate ElevenLabs render laid on the timeline with
its own trailing gap (build_headless_video.py assemble_voice()). The production
standard (founder-video-production-standard.md s2) wants every join MEASURED
against the distribution of ordinary moments in the same render rather than
asserted inaudible, and check-join-audibility.js needs the join timestamps to do
that.

assemble_voice() writes `<work>/joins.json` itself -- the exact ms-snapped onsets
it handed to adelay -- and this script just prints that file. (It used to
re-derive the arithmetic from the per-beat wavs; a 0.4ms disagreement between the
two put a 3-sample partial frame next to a full frame and read as a 30 dB step,
so the thing that placed the beats is now the only source of the numbers.)
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WORK_ROOT = "/home/heath/mw/headless"


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: joins_from_build.py <spec.json>")
    sp = sys.argv[1]
    if not os.path.isabs(sp):
        cand = os.path.join(HERE, sp)
        sp = cand if os.path.exists(cand) else os.path.abspath(sp)
    spec = json.load(open(sp, encoding="utf-8"))
    path = os.path.join(WORK_ROOT, spec["slug"], "joins.json")
    if not os.path.exists(path):
        sys.exit("no joins.json for this build (has build_headless_video.py run since "
                 "2026-10-09?): %s" % path)
    sys.stdout.write(open(path).read().strip() + "\n")


if __name__ == "__main__":
    main()
