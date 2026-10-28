"""The example script is what the extension's tests and the README point at: it must stay clean."""

from __future__ import annotations

from pathlib import Path

from kiosune_tools import kio_check

EXAMPLE = Path(__file__).resolve().parents[1] / "examples" / "lamp-room.kio.txt"


def test_example_passes_the_flow_check():
    err, warn, _ = kio_check.check(kio_check.load(str(EXAMPLE)), str(EXAMPLE))
    assert (err, warn) == ([], [])
