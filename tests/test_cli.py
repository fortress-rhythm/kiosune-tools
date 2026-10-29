"""kio-check's audio and progress reports, and fx-diff, run as the commands a user runs."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest


def _run(tool: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", f"kiosune_tools.{tool}", *args], capture_output=True, text=True
    )


def _check(tmp_path: Path, script: str, *flags: str) -> subprocess.CompletedProcess[str]:
    path = tmp_path / "t.kio.txt"
    path.write_text(script, encoding="utf-8")
    return _run("kio_check", str(path), *flags)


AUDIO_SCRIPT = """\
@scene Library · then
# SOUND: room tone, a wall clock
@music "Sorrow & Reflection" loop fade 2000
Narration.
@label now
@scene Library · now
# SOUND: colder room tone
Narration.
@sfx Thud
@scene Library · back room
# SOUND: the bulb hums
Narration.
@end
"""


def test_audio_pass_lists_open_sound_anchors(tmp_path: Path) -> None:
    proc = _check(tmp_path, AUDIO_SCRIPT, "--audio")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    out = proc.stdout
    assert "open # SOUND: room tone" not in out  # answered by @music before the next @scene
    assert "open # SOUND: colder room tone" not in out  # answered by @sfx in the same scene
    assert ":11 open # SOUND: the bulb hums" in out
    assert "music cues: Sorrow & Reflection" in out
    assert "sfx cues: Thud" in out
    assert "audio: 1 open # SOUND anchor(s) · 1 music · 0 ambience · 1 sfx · 0 voice" in out


def test_audio_pass_is_advisory(tmp_path: Path) -> None:
    proc = _check(tmp_path, AUDIO_SCRIPT)
    assert proc.returncode == 0, proc.stdout
    assert "NOTE  " in proc.stdout and "open # SOUND: the bulb hums" in proc.stdout
    assert "0 error(s), 0 warning(s)" in proc.stdout


def test_progress_counts_blanks_and_anchors_per_section(tmp_path: Path) -> None:
    script = """\
== Then
# BEAT: set the room
: ___
Laila: ___ and ___
# ═════════ HUB ═════════
# STATE: early
: Written.
@end E
"""
    proc = _check(tmp_path, script, "--progress")
    assert proc.returncode == 0, proc.stdout
    rows = {line.split()[0]: line.split()[1:] for line in proc.stdout.splitlines()
            if line.startswith("  ") and "blank" in line}
    assert rows["Then"][:4] == ["3", "blank", "1", "anchor"], proc.stdout
    assert rows["HUB"][:4] == ["0", "blank", "1", "anchor"], proc.stdout
    assert rows["TOTAL"][:4] == ["3", "blank", "2", "anchor"], proc.stdout


def test_progress_is_opt_in(tmp_path: Path) -> None:
    assert "PROGRESS" not in _check(tmp_path, ": ___\n@end E\n").stdout


def _fx_diff(tmp_path: Path, before: str, after: str, *flags: str) -> subprocess.CompletedProcess[str]:
    (tmp_path / "a.kio.txt").write_text(before, encoding="utf-8")
    (tmp_path / "b.kio.txt").write_text(after, encoding="utf-8")
    return _run("fx_diff", str(tmp_path / "a.kio.txt"), str(tmp_path / "b.kio.txt"), *flags)


FX_BEFORE = """\
@scene Library · now | fade 600
# FX: colder, a tube flickering
Laila: ___
@when late
Laila: ___
?
- Look -> a
- Leave -> b
"""


def test_fx_diff_accepts_fx_insertions(tmp_path: Path) -> None:
    after = FX_BEFORE.replace("# FX: colder, a tube flickering\n",
                              "# FX: colder, a tube flickering\n@grade cold 800\n@fx flicker\n")
    proc = _fx_diff(tmp_path, FX_BEFORE, after)
    assert proc.returncode == 0, proc.stdout
    assert "2 FX line(s) added" in proc.stdout


def test_fx_diff_rejects_prose_changes_and_traps(tmp_path: Path) -> None:
    after = FX_BEFORE.replace("@when late\n", "@when late\n@shake 4 300\n").replace(
        "Laila: ___\n?", "Laila: I wrote this.\n?")
    proc = _fx_diff(tmp_path, FX_BEFORE, after)
    assert proc.returncode == 1
    assert "directly after @when" in proc.stdout
    assert "changed: Laila: ___" in proc.stdout


@pytest.mark.parametrize("before, after", [
    (FX_BEFORE, FX_BEFORE.replace("| fade 600", "| fade 900")),
    ("@scene A\n@shake 4 300\nHi.\n@end\n", "@scene A\n@shake 6 300\nHi.\n@end\n"),
])
def test_fx_diff_tier2_tunes_numbers_only(tmp_path: Path, before: str, after: str) -> None:
    assert _fx_diff(tmp_path, before, after).returncode == 1
    proc = _fx_diff(tmp_path, before, after, "--tier2")
    assert proc.returncode == 0, proc.stdout
    assert "1 line(s) tuned" in proc.stdout


def test_fx_diff_tier2_rejects_renames(tmp_path: Path) -> None:
    renamed = FX_BEFORE.replace("@scene Library · now | fade 600", "@scene Library · then | fade 900")
    assert _fx_diff(tmp_path, FX_BEFORE, renamed, "--tier2").returncode == 1


def test_fx_diff_rejects_stage_block_and_subroutine(tmp_path: Path) -> None:
    before = """\
@scene A
@show Laila at 132,270 as neutral
@transition dissolve 500
Hi.
@call sting
@end
@label sting
@sfx Thud
@return
"""
    after = before.replace("as neutral\n", "as neutral\n@fx dust_motes\n").replace(
        "@sfx Thud\n", "@sfx Thud\n@shake 4 300\n")
    proc = _fx_diff(tmp_path, before, after)
    assert proc.returncode == 1
    assert "inside a stage block" in proc.stdout
    assert "inside the subroutine sting" in proc.stdout


# ── conformance with the official cheat sheet ────────────────────────────────


def test_audio_stop_does_not_end_the_chain(tmp_path: Path) -> None:
    """`@stop music 1500` is audio; only a bare `@stop` ends the chain."""
    audio = _check(tmp_path, "@label a\n@stop music 1500\n: this still plays\n@end E\n")
    assert "unreachable" not in audio.stdout, audio.stdout
    assert "falls off the end" not in audio.stdout, audio.stdout

    chain = _check(tmp_path, "@label a\n@stop\n@label b\n: never reached\n@end E\n")
    assert "@label b is unreachable" in chain.stdout, chain.stdout


def test_inline_random_and_import_are_understood(tmp_path: Path) -> None:
    proc = _check(
        tmp_path,
        "@label top\n@random: 3 -> a, 1 -> b\n"
        "@label a\n@end A\n"
        "@label b\n@import \"code\" -> resumed else fresh case\n"
        "- HONEY-A* : trust = 70\n"
        "@label resumed\n@if trust >= 50 -> fresh\n@label fresh\n@end F\n",
    )
    assert proc.returncode == 0, proc.stdout
    assert "does not resolve" not in proc.stdout, proc.stdout
    assert "unreachable" not in proc.stdout, proc.stdout


def test_ending_then_label_is_reachable(tmp_path: Path) -> None:
    proc = _check(tmp_path, "@label a\n@end Done [key done] [then credits]\n@label credits\n: thanks\n@end C\n")
    assert proc.returncode == 0, proc.stdout
    assert "unreachable" not in proc.stdout, proc.stdout


def test_timer_index_is_optional_and_takes_flags(tmp_path: Path) -> None:
    menu = "? pick  {tag}\n- a -> L\n- b -> L\n- c -> L\n@label L\n@end E\n"
    for tag in ("[timer 9000]", "[timer 9000 3 fill nobar nopause]"):
        proc = _check(tmp_path, menu.format(tag=tag))
        assert "timer" not in proc.stdout, (tag, proc.stdout)
    bad = _check(tmp_path, menu.format(tag="[timer 9000 9]"))
    assert "timer targets option 9" in bad.stdout, bad.stdout


def test_documented_syntax_is_not_flagged(tmp_path: Path) -> None:
    """visited() and a multi-assignment [set] are both on the official cheat sheet."""
    proc = _check(
        tmp_path,
        "@label a\n? pick\n- go -> b [set trust = 70; late = no]\n"
        "@label b\n@if visited(a) >= 1 -> c\n@label c\n@if trust >= 50 -> d else d\n@label d\n"
        "@if late -> e else e\n@label e\n@end E\n",
    )
    assert "visited()" not in proc.stdout, proc.stdout
    assert "several assignments" not in proc.stdout, proc.stdout
    assert proc.returncode == 0, proc.stdout
