#!/usr/bin/env python3
"""Static flow-check for a Kiosune script export.

Runs the mechanical half of a flow check — everything that does not depend on runtime
state. The syntax it accepts is the official cheat sheet,
<https://kiosune.com/tutorials/script-cheat-sheet>. Usage:

    kio-check script.kio.txt
    kio-check script.kio.txt --progress

--progress adds a burn-down per section: how many ___ blanks are still unwritten and
how many # BEAT:/# STATE: anchors are still standing. Both only ever go down, so the
totals are the honest answer to "how much script is left".

Exit code 1 if any ERROR is reported. WARN and NOTE are advisory. Note what this
cannot see: gate reachability — whether the player can still reach the passage that
sets a flag some later gate needs. That stays a reading job.

The audio pass lists every `# SOUND:` anchor still waiting for a cue, plus the cues already
placed. `--audio` prints only that list — the to-do for the audio pass:

    kio-check script.kio.txt --audio
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field

COND_WORDS = {"and", "or", "not", "else", "yes", "no", "true", "false"}
ARROW = re.compile(r"->\s*([A-Za-z_][\w]*)")
SET_WRITE = re.compile(r"\b([A-Za-z_]\w*)\s*(?:=|\+=|-=|%\+=|%-=)")
SEEN = re.compile(r"\b(?:seen|visited)\(\s*([A-Za-z_]\w*)\s*\)")
IDENT = re.compile(r"[A-Za-z_]\w*")
# [timer ms [n] [fill] [nobar] [nopause]] — the index is optional and flags may follow it
TIMER = re.compile(r"\[timer\s+\d+(?:\s+(\d+))?(?:\s+(?:fill|nobar|nopause))*\s*\]")
THEN = re.compile(r"\[then\s+([A-Za-z_]\w*)\s*\]")
ELSE_TARGET = re.compile(r"\belse\s+(?:->\s*)?([A-Za-z_]\w*)\s*$")
KIO_SUFFIXES = (".kio.txt", ".kio", ".kiosune")
AUDIO = ("music", "ambience", "sfx", "voice")
AUDIO_CHANNELS = AUDIO  # the cheat sheet lists exactly these four
SOUND_ANCHOR = re.compile(r"^#\s*SOUND\b\s*:?\s*(.*)$")
AUDIO_OPTS = re.compile(r"\s+(?:loop\b|fade\s+\d+|keep\b).*$")
# The cheat sheet's closed vocabularies for actors: `places:` and `motions:`.
PLACES = {"farleft", "left", "center", "right", "farright", "offscreen"}
MOTIONS = {"fade", "slideleft", "slideright", "drop", "rise"}
COORD = r"-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?"
PLACE_AT = {"show": re.compile(rf"\bat\s+({COORD}|\S+)"), "move": re.compile(rf"\bto\s+({COORD}|\S+)")}
MOTION_AT = {"show": re.compile(r"\benter\s+(\S+)"), "hide": re.compile(r"\bexit\s+(\S+)")}
# `{pause=ms}` `{speed=x}` `{color=#hex}` `{var=id}`: the tag name must be followed by `=`.
MARKUP_TAG = re.compile(r"(?<!\\)\{\s*(pause|speed|color|var)\b(?!=)", re.IGNORECASE)
# `Name (expr) as "Plate":` -- the studio needs the plate first: `Name as "Plate" (expr):`.
EXPR_FIRST = re.compile(r"""^(?:[~!+^_]\s?)?([A-Za-z .'\-]{1,24}?)\s*\(([\w ]+)\)\s+as\s+"([^"]*)"\s*:""")
# A `#` after a space that does not start a #hex colour (`@flash #ffffff 200`) starts a comment.
TRAILING_COMMENT = re.compile(r"\s#(?![0-9A-Fa-f]{3,8}\b)")
# Directives whose arguments are free text or quoted, where a `#` is just a character.
FREE_TEXT = {"caption", "input", "export", "import", "channel", "end"}


@dataclass
class Script:
    lines: list[str]
    labels: dict[str, int] = field(default_factory=dict)
    dupes: list[tuple[str, int]] = field(default_factory=list)

    def code(self, i: int) -> str:
        return self.lines[i].strip()

    def is_skip(self, i: int) -> bool:
        s = self.code(i)
        return not s or s.startswith("#")


def directive(line: str) -> str | None:
    """The directive name of a line ("@music x" -> "music"), compared as a whole token."""
    s = line.strip()
    return s[1:].split(None, 1)[0] if s.startswith("@") and len(s) > 1 else None


def is_terminal(s: str) -> bool:
    """@end and @return end the chain, and so does a bare @stop — but `@stop music 800` is audio.

    The cheat sheet glosses `@end Name` as "end the story" and `@stop` as "end this chain",
    and lists `@stop music|ambience|sfx|voice [ms]` separately as the audio command.
    """
    d = directive(s)
    if d in ("end", "return"):
        return True
    if d != "stop":
        return False
    rest = s.strip()[len("@stop"):].split()
    return not rest or rest[0].lower() not in AUDIO_CHANNELS


def load(path: str) -> Script:
    sc = Script(lines=open(path, encoding="utf-8").read().splitlines())
    for i, raw in enumerate(sc.lines):
        s = raw.strip()
        if s.startswith("@label "):
            name = s.split(None, 1)[1].strip()
            if name in sc.labels:
                sc.dupes.append((name, i))
            else:
                sc.labels[name] = i
    return sc


def next_code_or_blank(sc: Script, i: int) -> int | None:
    """The line right after `i`, skipped or not — where a choice was cut off."""
    return i + 1 if i + 1 < len(sc.lines) else None


def _has_option_below(sc: Script, i: int) -> bool:
    """Is there a `-` option under this blank line or comment, with only skips between?"""
    for j in range(i + 1, len(sc.lines)):
        if sc.code(j).startswith("- "):
            return True
        if not sc.is_skip(j):
            return False
    return False


def next_code(sc: Script, i: int) -> int | None:
    j = i + 1
    while j < len(sc.lines) and sc.is_skip(j):
        j += 1
    return j if j < len(sc.lines) else None


def block_rows(sc: Script, i: int) -> tuple[list[int], int]:
    """Rows of a choice/router block: consecutive '-' lines, skipping nothing."""
    rows, j = [], i + 1
    while j < len(sc.lines) and sc.code(j).startswith("- "):
        rows.append(j)
        j += 1
    return rows, j


def successors(sc: Script, i: int, enter_calls: bool = True) -> tuple[list[int], bool]:
    """(explicit targets as line numbers, falls_through).

    With `enter_calls=False` a `@call` does not step into its subroutine: it only continues
    where the call returns to. That is the walk that finds a `@return` with no caller.
    """
    s = sc.code(i)
    tgt: list[int] = []

    def resolve(name: str) -> None:
        if name in sc.labels:
            tgt.append(sc.labels[name])

    if is_terminal(s):
        # `@end Name [then label]` carries on at that label instead of the title screen.
        m = THEN.search(s)
        if m:
            resolve(m.group(1))
        return tgt, False
    if s.startswith("@jump "):
        resolve(s.split(None, 1)[1].strip())
        return tgt, False
    if s.startswith("@call "):
        rest = s.split(None, 1)[1]
        parts = rest.split()
        if enter_calls:
            resolve(parts[0])
        if "return" in parts:
            resolve(parts[parts.index("return") + 1])
            return tgt, False
        return tgt, True
    if s.startswith("@if "):
        for m in ARROW.finditer(s):
            resolve(m.group(1))
        m = ELSE_TARGET.search(s)
        if m:
            resolve(m.group(1))
        return tgt, m is None
    if s.startswith("@switch ") or s.startswith("@random"):
        for m in ARROW.finditer(s):
            resolve(m.group(1))
        return tgt, False
    if s.startswith("@import "):
        for m in ARROW.finditer(s):
            resolve(m.group(1))
        m = ELSE_TARGET.search(s.split("[")[0].strip())
        if m:
            resolve(m.group(1))
        return tgt, m is None
    if s.startswith("@router"):
        rows, _ = block_rows(sc, i)
        for r in rows:
            for m in ARROW.finditer(sc.code(r)):
                resolve(m.group(1))
        return tgt, False
    if s.startswith("?"):
        rows, after = block_rows(sc, i)
        if not rows:
            # the choice was ended early by a blank line or comment; the report for that
            # is enough, and treating it as a dead end just buries it in cascade
            return tgt, True
        fall = False
        for r in rows:
            row = sc.code(r)
            if "->" in row:
                for m in ARROW.finditer(row):
                    resolve(m.group(1))
            else:
                fall = True  # no-arrow option = default path, continues below
        if fall and after < len(sc.lines):
            tgt.append(after)
        return tgt, False
    return tgt, True


def audio_pass(sc: Script) -> tuple[list[tuple[int, str]], dict[str, Counter[str]]]:
    """([(line, text) of open # SOUND: anchors], {directive: Counter of cue names}).

    An anchor is answered by any @music/@ambience/@sfx/@voice between it and the next
    @scene, @label or chapter — so the comment can stay as a note once the cue is placed.
    """
    cues: dict[str, Counter[str]] = {d: Counter() for d in AUDIO}
    for raw in sc.lines:
        d = directive(raw)
        if d in cues:
            cues[d][AUDIO_OPTS.sub("", raw.strip()[len(d) + 1:].strip()).strip('"')] += 1
    open_: list[tuple[int, str]] = []
    for i, raw in enumerate(sc.lines):
        m = SOUND_ANCHOR.match(raw.strip())
        if not m:
            continue
        stop = next((j for j in range(i + 1, len(sc.lines))
                     if directive(sc.lines[j]) in (*AUDIO, "scene", "label")
                     or sc.code(j).startswith("==")), None)
        if stop is None or directive(sc.lines[stop]) not in cues:
            open_.append((i, m.group(1)))
    return open_, cues


def audio_report(sc: Script, path: str) -> list[str]:
    open_sound, cues = audio_pass(sc)
    out = [f"{path}:{i + 1} open # SOUND: {text}" for i, text in open_sound]
    for d, c in cues.items():
        if c:
            out.append(f"{d} cues: " + ", ".join(f"{n} ×{k}" if k > 1 else n for n, k in c.items()))
    out.append(f"audio: {len(open_sound)} open # SOUND anchor(s) · "
               + " · ".join(f"{len(c)} {d}" for d, c in cues.items()))
    return out


SECTION = re.compile(r"^#\s*[═─]{3,}\s*(.+?)\s*[═─]{3,}\s*$")
BLANK = "___"


def progress(sc: Script) -> list[tuple[str, int, int]]:
    """(section, unwritten blanks, standing BEAT/STATE anchors), in file order."""
    rows: list[tuple[str, int, int]] = []
    name, blanks, anchors = "header", 0, 0
    for raw in sc.lines:
        s = raw.strip()
        m = SECTION.match(s)
        if m or s.startswith("== "):
            rows.append((name, blanks, anchors))
            name = m.group(1) if m else s[3:].strip()
            if len(name) > 38:
                name = name[:37] + "…"
            blanks = anchors = 0
            continue
        if s.startswith("#"):
            if re.match(r"#\s*(BEAT|STATE)\b", s):
                anchors += 1
            continue
        blanks += s.count(BLANK)
    rows.append((name, blanks, anchors))
    return [r for r in rows if r[1] or r[2]]


def report(sc: Script, path: str) -> None:
    rows = progress(sc)
    width = max((len(n) for n, _, _ in rows), default=0)
    tb = sum(r[1] for r in rows)
    ta = sum(r[2] for r in rows)
    print(f"\nPROGRESS  {path}")
    for name, blanks, anchors in rows:
        bar = "█" * min(blanks, 40)
        print(f"  {name:<{width}}  {blanks:>4} blank  {anchors:>3} anchor  {bar}")
    print(f"  {'TOTAL':<{width}}  {tb:>4} blank  {ta:>3} anchor")
    print("  every ___ is a line to write; every anchor is a note to delete once you have")



def check(sc: Script, path: str) -> tuple[list[str], list[str], list[str]]:
    """(errors, warnings, notes) for the script already loaded from `path`."""
    err: list[str] = []
    warn: list[str] = []
    note: list[str] = []

    def at(i: int) -> str:
        return f"{path}:{i + 1}"

    for name, i in sc.dupes:
        err.append(f"{at(i)} duplicate @label {name}")

    # 1. target resolution
    targeted: set[str] = set()
    for i, raw in enumerate(sc.lines):
        s = raw.strip()
        if s.startswith("#") or not s:
            continue
        names = [m.group(1) for m in ARROW.finditer(s)]
        if s.startswith("@jump ") or s.startswith("@call "):
            parts = s.split(None, 1)[1].split()
            names.append(parts[0])
            if "return" in parts:
                names.append(parts[parts.index("return") + 1])
        names += [m.group(1) for m in SEEN.finditer(s)]
        if s.startswith("@if ") or s.startswith("@import "):
            m = ELSE_TARGET.search(s.split("[")[0].strip())
            if m:
                names.append(m.group(1))
        names += [m.group(1) for m in THEN.finditer(s)]
        for n in names:
            targeted.add(n)
            if n not in sc.labels:
                err.append(f"{at(i)} target does not resolve: {n}")
        for m in SEEN.finditer(s):
            if re.fullmatch(r"l_\d+", m.group(1)):
                warn.append(f"{at(i)} seen() on an auto-generated label: {m.group(1)}")

    for name, i in sorted(sc.labels.items(), key=lambda kv: kv[1]):
        if name not in targeted:
            note.append(f"{at(i)} @label {name} is never targeted")

    # 2. choice hygiene
    for i, raw in enumerate(sc.lines):
        if not raw.strip().startswith("?"):
            continue
        rows, after = block_rows(sc, i)
        if not rows:
            j = next_code_or_blank(sc, i)
            cut = j is not None and sc.is_skip(j) and _has_option_below(sc, j)
            if cut:
                err.append(f"{at(j)} blank line or comment inside a choice: it ends the choice early")
            else:
                err.append(f"{at(i)} choice has no options")
            continue
        # a comment or blank directly under ? would have ended the block at zero rows above;
        # catch the subtler case: comment/blank in the middle of the option run
        j = i + 1
        while j < len(sc.lines) and (sc.code(j).startswith("- ") or sc.is_skip(j)):
            if sc.is_skip(j) and j + 1 < len(sc.lines) and sc.code(j + 1).startswith("- "):
                err.append(f"{at(j)} blank line or comment inside a choice: it ends the choice early")
            j += 1
        uncond = [r for r in rows if "[if " not in sc.code(r)]
        if not uncond:
            err.append(f"{at(i)} every option is conditional: this choice can render empty")
        m = TIMER.search(sc.code(i))
        if m and m.group(1):
            n = int(m.group(1))
            if n > len(rows):
                err.append(f"{at(i)} timer targets option {n} but the choice has {len(rows)}")
            else:
                for k in range(n):
                    if "[if " in sc.code(rows[k]):
                        err.append(f"{at(rows[k])} conditional option at position {k + 1} is at or "
                                   f"above the timer's target ({n}): a hidden option shifts the index")

    # 3. @when guards only the next line
    for i, raw in enumerate(sc.lines):
        if not raw.strip().startswith("@when "):
            continue
        j = i + 1
        if j >= len(sc.lines) or sc.is_skip(j):
            err.append(f"{at(i)} @when is followed by a comment or blank line: it guards nothing")
        elif sc.code(j).startswith("@when "):
            warn.append(f"{at(i)} @when directly followed by another @when: check this is intended")

    # 4. unprefixed colon in narration
    for i, raw in enumerate(sc.lines):
        s = raw.strip()
        if not s or s[0] in "#@?-:=+~!^_" or s.startswith("=="):
            continue
        if ":" in s:
            head = s.split(":", 1)[0]
            # the plate and the expression in either order; the studio takes `Name as "plate" (expr)`
            speaker = r"""[A-Za-z .'\-]{1,24}((\s*\([\w ]+\))?(\s+as\s+"[^"]*")?|\s+as\s+"[^"]*"\s*\([\w ]+\))"""
            if not re.fullmatch(speaker, head):
                warn.append(f"{at(i)} narration contains a colon without a leading ':' — "
                            f"'{head[:30]}' may parse as a speaker")

    # 4b. plate after the expression: the studio does not accept it (tested 2026-10-16)
    for i, raw in enumerate(sc.lines):
        m = EXPR_FIRST.match(raw.strip())
        if m and not raw.strip().startswith(("@", "-", "?", "#")):
            name, expr, plate = m.group(1).strip(), m.group(2).strip(), m.group(3)
            warn.append(f'{at(i)} plate after the expression: \'{name} ({expr}) as "{plate}"\' does not '
                        f'work in the studio -- write \'{name} as "{plate}" ({expr}):\'')

    # 5. variables
    writes: dict[str, list[int]] = defaultdict(list)
    reads: dict[str, list[int]] = defaultdict(list)
    for i, raw in enumerate(sc.lines):
        s = raw.strip()
        if s.startswith("#") or not s:
            continue
        for chunk in re.findall(r"\[set ([^\]]*)\]", s):
            for m in SET_WRITE.finditer(chunk):
                writes[m.group(1)].append(i)
        if s.startswith("@input "):
            writes[s.split()[1]].append(i)
        if s.startswith("@set ") or s.startswith("@toggle "):
            body = s.split(None, 1)[1]
            m = SET_WRITE.search(body) or IDENT.search(body)
            if m:
                writes[m.group(1)].append(i)
        cond = ""
        if s.startswith(("@if ", "@when ", "@switch ")):
            cond = s.split(None, 1)[1]
        elif s.startswith("- ") and _preceding(sc, i).startswith("@router"):
            cond = s[2:].split("->")[0]
        elif s.startswith("- ") and _preceding(sc, i).startswith("@import "):
            # `- PATTERN : var = v; …` — the assignments are writes, the glob is not a condition
            body = s[2:].split(":", 1)
            if len(body) == 2:
                for m in SET_WRITE.finditer(body[1]):
                    writes[m.group(1)].append(i)
            continue
        for chunk in re.findall(r"\[if ([^\]]*)\]", s):
            cond += " " + chunk
        cond = SEEN.sub(" ", cond)
        # Everything after the arrow is a target, and seen()/visited() arguments are labels:
        # both are already gone, so what is left is read as state even if a label shares its name.
        cond = re.sub(r'"[^"]*"', " ", cond.split("->")[0])
        for m in IDENT.finditer(cond):
            n = m.group(0)
            if n not in COND_WORDS:
                reads[n].append(i)
    # `{var=X}` in a line reads X -- or, for a converted script's placeholder, the variable its
    # header's References row names (`#   References  REF_ANNA_PLATE = anna_plate`)
    refs = references(sc)
    for i, raw in enumerate(sc.lines):
        if raw.strip().startswith("#"):
            continue
        for m in re.finditer(r"\{var=([A-Za-z_]\w*)\}", raw):
            name = refs.get(m.group(1), m.group(1))
            if name in writes or m.group(1) in refs:
                reads[name].append(i)
    for v in sorted(set(writes) - set(reads)):
        warn.append(f"variable '{v}' is written (line {writes[v][0] + 1}) but never read")
    for v in sorted(set(reads) - set(writes)):
        warn.append(f"variable '{v}' is read (line {reads[v][0] + 1}) but never written")

    # 6. vocabulary and markup the importer would misread
    for i, raw in enumerate(sc.lines):
        s = raw.strip()
        if not s or s.startswith("#"):
            continue
        d = directive(s)
        if d is None:
            if s.startswith("- ") and _preceding(sc, i).startswith(("@router", "@import ")):
                continue
            for m in MARKUP_TAG.finditer(s):
                warn.append(f"{at(i)} malformed markup: '{{{m.group(1)}' needs '=' "
                            f"({{{m.group(1).lower()}=…}})")
            continue
        args = s[len(d) + 1:]
        if d in ("caption", "end"):
            for m in MARKUP_TAG.finditer(args):
                warn.append(f"{at(i)} malformed markup: '{{{m.group(1)}' needs '=' "
                            f"({{{m.group(1).lower()}=…}})")
        if d not in FREE_TEXT and TRAILING_COMMENT.search(re.sub(r'"[^"]*"', '""', args)):
            warn.append(f"{at(i)} comment on a directive line: a '#' after the command is read as "
                        f"part of it — move the comment to its own line")
        if d in PLACE_AT:
            m = PLACE_AT[d].search(args.split("#")[0])
            if m and not re.fullmatch(COORD, m.group(1)) and m.group(1) not in PLACES:
                hint = (f"write '{m.group(1).lower()}'" if m.group(1).lower() in PLACES
                        else "use " + " ".join(sorted(PLACES)) + " or x,y")
                warn.append(f"{at(i)} '{m.group(1)}' is not a place: places are lowercase keywords — {hint}")
        if d in MOTION_AT:
            m = MOTION_AT[d].search(args)
            if m and m.group(1) not in MOTIONS:
                warn.append(f"{at(i)} '{m.group(1)}' is not an entrance or exit motion "
                            f"(fade slideleft slideright drop rise)")
        if d == "adv" and args.strip():
            warn.append(f"{at(i)} @adv takes no argument: the cheat sheet has '@nvl [clear]' but a bare '@adv'")

    # 7. reachability + dead ends, from the first code line
    start = next_code(sc, -1)
    seen_lines: set[int] = set()
    stack = [start] if start is not None else []
    while stack:
        i = stack.pop()
        if i is None or i in seen_lines or i >= len(sc.lines):
            continue
        if sc.is_skip(i):
            nxt = next_code(sc, i)
            stack.append(nxt)
            continue
        seen_lines.add(i)
        tgt, fall = successors(sc, i)
        stack.extend(tgt)
        if fall:
            nxt = next_code(sc, i)
            if nxt is None:
                err.append(f"{at(i)} route falls off the end of the file without @end/@stop/@jump")
            else:
                stack.append(nxt)
    for name, i in sorted(sc.labels.items(), key=lambda kv: kv[1]):
        if i not in seen_lines:
            err.append(f"{at(i)} @label {name} is unreachable from the first line")

    # 8. a @return the story reaches without a @call: walk again, stepping over calls, and any
    # @return still reached was entered by a jump, an option, a branch or a fall-through.
    top: set[int] = set()
    stack = [start] if start is not None else []
    while stack:
        i = stack.pop()
        if i is None or i in top or i >= len(sc.lines):
            continue
        if sc.is_skip(i):
            stack.append(next_code(sc, i))
            continue
        top.add(i)
        if directive(sc.code(i)) == "return":
            label = max((n for n, j in sc.labels.items() if j < i), key=sc.labels.get, default="the start")
            warn.append(f"{at(i)} @return reached without a @call: {label} is entered by a jump, "
                        f"option, branch or fall-through, so this @return has no caller")
            continue
        tgt, fall = successors(sc, i, enter_calls=False)
        stack.extend(tgt)
        if fall:
            stack.append(next_code(sc, i))

    note += audio_report(sc, path)  # the audio to-do list, never an error

    ends = [i for i, r in enumerate(sc.lines) if r.strip().startswith("@end")]
    note.append(f"{len(sc.labels)} labels · {len(ends)} endings · "
                f"{sum(1 for i in range(len(sc.lines)) if not sc.is_skip(i))} code lines")

    return err, warn, note


def main() -> int:
    ap = argparse.ArgumentParser(description="static flow check for a Kiosune script")
    ap.add_argument("script", help="the .kio.txt (or exported .txt) to check")
    ap.add_argument("--audio", action="store_true", help="print only the audio to-do list")
    ap.add_argument("--progress", action="store_true", help="add a per-section burn-down")
    args = ap.parse_args()
    sc = load(args.script)
    if args.audio:
        print("\n".join(audio_report(sc, args.script)))
        return 0
    err, warn, note = check(sc, args.script)
    for tag, items in (("ERROR", err), ("WARN", warn), ("NOTE", note)):
        for m in items:
            print(f"{tag}  {m}")
    print(f"\n{len(err)} error(s), {len(warn)} warning(s)")
    if args.progress:
        report(sc, args.script)
    return 1 if err else 0


def references(sc: Script) -> dict[str, str]:
    """The header's `References  REF_X = var · ...` row (and its continuation lines)."""
    refs: dict[str, str] = {}
    inside = False
    for raw in sc.lines:
        s = raw.strip()
        if not s.startswith("#"):
            continue
        body = s[1:].strip()
        m = re.match(r"References\s+(.*)$", body)
        if m:
            inside, body = True, m.group(1)
        elif not inside or not re.match(r"[A-Za-z_]\w*\s*=\s*[A-Za-z_]\w*", body) or not raw.startswith("#   "):
            inside = False
            continue
        for part in body.split("·"):
            pm = re.fullmatch(r"\s*([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*", part)
            if pm:
                refs[pm.group(1)] = pm.group(2)
    return refs


def _preceding(sc: Script, i: int) -> str:
    j = i - 1
    while j >= 0 and sc.code(j).startswith("- "):
        j -= 1
    return sc.code(j) if j >= 0 else ""


if __name__ == "__main__":
    raise SystemExit(main())
