#!/usr/bin/env python3
"""Mechanical check of an FX pass: prove that only effect lines were added.

    fx-diff before.kio.txt after.kio.txt [--tier2]

Tier 1 (always): the only change is inserted lines, each starting with @fx, @grade,
@effect, @ambience, @shake, @flash or @overlay — deleting them gives back the original
byte-for-byte — and none sits in an insertion trap: right after a @when (it steals the guard), between a
choice and its options, before a + extend line, inside a stage block, or inside a
subroutine (it would run in every scene that calls it).
Tier 2 (--tier2): additionally allow numeric or #hex tokens to change on existing
@transition, @flash, @shake, @overlay lines and on the `| kind ms` part of @scene.

Exit code 1 on any violation.
"""

from __future__ import annotations

import argparse
import bisect
import difflib
import re

try:
    from .kio_check import directive, load
except ImportError:  # run as a loose script next to kio_check.py
    from kio_check import directive, load

TIER1 = {"fx", "grade", "effect", "ambience", "shake", "flash", "overlay"}
TIER2 = {"transition", "flash", "shake", "overlay"}
STAGE = {"show", "move", "hide"}
TOKEN = re.compile(r"#[0-9A-Fa-f]{3,8}\b|-?\d+(?:\.\d+)?")


def _shape(line: str) -> str:
    return TOKEN.sub("·", line)


def tier2_ok(old: str, new: str) -> bool:
    o, n = old.strip(), new.strip()
    if directive(o) == directive(n) == "scene":
        o_head, _, o_tail = o.partition("|")
        n_head, _, n_tail = n.partition("|")
        return o_head == n_head and _shape(o_tail) == _shape(n_tail)
    return directive(o) in TIER2 and _shape(o) == _shape(n)


def trap(b: list[str], inserted: set[int], j: int, subroutines: list[tuple[int, str | None]]) -> str | None:
    """Why the FX line inserted at b[j] falls into an insertion trap, or None."""
    k = j - 1
    while k >= 0 and (k in inserted or not b[k].strip()):
        k -= 1
    prev = b[k].strip() if k >= 0 else ""
    k = j + 1
    while k < len(b) and k in inserted:
        k += 1
    nxt = b[k].strip() if k < len(b) else ""
    if directive(prev) == "when":
        return "directly after @when — it would steal the guard"
    if prev.startswith(("?", "- ")) and nxt.startswith("- "):
        return "between a choice and its options"
    if nxt.startswith("+"):
        return "between a line and its + extend line"
    if directive(prev) in STAGE:
        return "inside a stage block — it would split one stage change into two"
    k = bisect.bisect_right([line for line, _ in subroutines], j) - 1
    if k >= 0 and subroutines[k][1]:
        return f"inside the subroutine {subroutines[k][1]} — it runs in every scene that calls it"
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description="check that an FX pass only added FX lines")
    ap.add_argument("before")
    ap.add_argument("after")
    ap.add_argument("--tier2", action="store_true", help="also allow re-tuned numbers and #hex")
    args = ap.parse_args()
    a = load(args.before).lines
    sb = load(args.after)
    b = sb.lines
    bad: list[str] = []
    inserted: set[int] = set()
    tuned = 0
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if op == "equal":
            continue
        # new FX lines are insertions wherever the diff put them; what is left must pair up
        # with the old lines one-for-one as Tier 2 tunings, or it is a violation
        old = list(range(i1, i2))
        new = list(range(j1, j2))
        if args.tier2:  # pair each old line with the first new line that is a pure re-tuning of it
            for i in list(old):
                j = next((j for j in new if tier2_ok(a[i], b[j])), None)
                if j is not None:
                    old.remove(i)
                    new.remove(j)
                    tuned += 1
        fx = [j for j in new if directive(b[j]) in TIER1 and b[j] not in a[i1:i2]]
        inserted.update(fx)
        rest = [j for j in new if j not in fx]
        if not old:
            for j in rest:
                why = "adds a blank line" if not b[j].strip() else \
                    f"inserted line is not an FX command: {b[j].strip()[:60]}"
                bad.append(f"{args.after}:{j + 1} {why}")
        gone = "changed" if rest else "deleted"
        bad += [f"{args.before}:{i + 1} {gone}: {a[i].strip()[:60]}" for i in old]
    called = {b[i].split()[1] for i in range(len(b)) if directive(b[i]) == "call" and len(b[i].split()) > 1}
    # (first line, subroutine name or None) for each @label block, in order
    subroutines = sorted((i, n if n in called else None) for n, i in sb.labels.items())
    for j in sorted(inserted):
        why = trap(b, inserted, j, subroutines)
        if why:
            bad.append(f"{args.after}:{j + 1} FX line {why}")
    for m in bad:
        print(f"ERROR  {m}")
    print(f"\n{len(inserted)} FX line(s) added · {tuned} line(s) tuned · {len(bad)} violation(s)")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
