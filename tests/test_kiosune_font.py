"""kiosune_tools/kiosune_font.py: sheets round-trip, the grid is found, the baseline is read."""

from __future__ import annotations

import random
from pathlib import Path

from PIL import Image

from kiosune_tools import kiosune_font as kf  # noqa: E402


def synthetic(cell_w: int, cell_h: int, base: int, chars: str, seed: int = 1) -> kf.Sheet:
    """A sheet of random blobs: capitals and digits sit on the baseline, lowercase g/j/p/q/y
    hang below it, and every glyph has its own width."""
    rnd = random.Random(seed)
    glyphs = {}
    for ch in chars:
        if ch == " ":
            glyphs[ch] = kf.Glyph(Image.new("1", (1, 1)), 0, 0)
            continue
        w = rnd.randint(1, cell_w)
        drop = cell_h - base if ch in "gjpqy" else 0
        h = rnd.randint(2, base) + drop
        img = Image.new("1", (w, h))
        for x in range(w):
            img.putpixel((x, 0), 1)
            img.putpixel((x, h - 1), 1)
        for y in range(h):
            img.putpixel((0, y), 1)
        glyphs[ch] = kf.Glyph(img, drop - h, 0)
    return kf.finish("synthetic", glyphs, [])


def test_sheet_round_trip(tmp_path):
    sheet = synthetic(6, 12, 10, kf.ASCII)
    path = tmp_path / "s.png"
    sheet.png().save(path)
    back = kf.from_sheet(path, "ascii")
    assert (back.cell_w, back.cell_h, back.baseline) == (sheet.cell_w, sheet.cell_h, sheet.baseline)
    assert back.chars == sheet.chars
    for ch, g in sheet.glyphs.items():
        if ch == " ":
            continue
        assert back.glyphs[ch].img.tobytes() == g.img.tobytes(), ch
        assert back.glyphs[ch].top == g.top, ch


def test_grid_found_on_a_padded_opaque_sheet(tmp_path):
    """Dark glyphs on a solid background, each in a roomy cell: the usual downloaded sheet."""
    sheet = synthetic(5, 9, 7, kf.ASCII, seed=7)
    grid = Image.new("RGB", (16 * 8, 6 * 12), (40, 30, 60))
    ink = sheet.png()
    for i, ch in enumerate(sheet.glyphs):
        cell = ink.crop(((i % 16) * sheet.cell_w, (i // 16) * sheet.cell_h,
                         (i % 16 + 1) * sheet.cell_w, (i // 16 + 1) * sheet.cell_h))
        grid.paste(cell, ((i % 16) * 8 + 1, (i // 16) * 12 + 1), cell)
    path = tmp_path / "padded.png"
    grid.save(path)
    assert kf.detect_cell(kf.ink_mask(Image.open(path))) == (8, 12)
    back = kf.from_sheet(path, "latin1")
    assert back.chars == sheet.chars


def test_text_layout_trims_to_ink():
    sheet = synthetic(6, 12, 10, kf.ASCII)
    w = sheet.glyphs["A"].img.size[0] + kf.Sheet.GAP + sheet.glyphs["B"].img.size[0]
    assert sheet.width("AB") == w
    rows = sheet.wrap("AAAA BBBB CCCC", sheet.width("AAAA BBBB"))
    assert rows == ["AAAA BBBB", "CCCC"]
