#!/usr/bin/env python3
"""Turn a pixel font (.ttf/.otf) or a glyph-sheet PNG into a Kiosune Studio bitmap font.

    kiosune-font monogram.ttf
    kiosune-font monogram.png               # a sheet: grid is detected
    kiosune-font sheet.png --cell 6x12 --order ascii
    kiosune-font font.ttf --size 16 --chars script --script story.kio.txt

Kiosune's "import bitmap font" wants a PNG grid of equal cells, one character per cell in
reading order, white (or any colour) on transparent, plus the cell size, the baseline and
the character list. It trims each glyph to its ink, so spacing comes out proportional.
This writes, into out/kiosune-fonts/:

  <name>.png        the grid, white on transparent, 16 cells a row
  <name>.txt        what to type into the dialog: name, cell w x h, baseline, characters
  <name>-proof.png  the grid at 4x with each cell's assigned character under it, to check
                    a sheet's order at a glance (no OCR: sheets follow a code-page order)

Character order for a sheet (--order): "latin1" (default) is U+0020-007E then U+00A0 on,
the usual layout of pixel-font sheets (Monogram's included); "ascii" stops at U+007E;
or give the characters themselves. Cells that are empty past the end are dropped.

--chars picks what goes in the grid from a font file: "ascii" (Kiosune's default 95),
"script" (ascii + every other character the script shows, if the font has it; default),
"latin1", or a literal string.

"baseline" is taken as the number of pixel rows above the baseline (Kiosune's default
8x12 cell has baseline 10: two rows below for descenders).
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ASCII = "".join(chr(c) for c in range(0x20, 0x7F))
LATIN1 = ASCII + "".join(chr(c) for c in range(0xA0, 0x100))
COLS = 16


# --- native pixel size of an outline "pixel" font -----------------------------------------

PROBE = "HAMBURGEFONSTIVhamburgefonstivwxyz0123456789"
BIG = 240


def grey_ratio(path: Path, size: float) -> float:
    """Share of inked pixels that are neither full on nor off, glyph by glyph, anti-aliased.
    0 means every glyph lands on whole pixels at this size."""
    f = ImageFont.truetype(str(path), size)
    ink = grey = 0
    for ch in PROBE:
        img = Image.new("L", (4 * int(size) + 16, 4 * int(size) + 16))
        ImageDraw.Draw(img).text((8, 3 * int(size) + 8), ch, font=f, fill=255, anchor="ls")
        a = np.asarray(img)
        ink += int((a > 0).sum())
        grey += int(((a > 24) & (a < 232)).sum())
    return grey / ink if ink else 1.0


def grid_size(path: Path) -> float | None:
    """The size at which one of the font's design pixels is one screen pixel: the period of
    the glyph edges in a big render (x and y both), or None when there is no single grid."""
    f = ImageFont.truetype(str(path), BIG)
    xs, ys = [], []
    for ch in PROBE:
        img = Image.new("L", (BIG * 2, BIG * 2))
        ImageDraw.Draw(img).text((BIG // 2, BIG * 3 // 2), ch, font=f, fill=255, anchor="ls")
        a = np.asarray(img) > 127
        xs.extend(np.nonzero(a[:, 1:] != a[:, :-1])[1] + 1 - BIG // 2)
        ys.extend(BIG * 3 // 2 - (np.nonzero(a[1:, :] != a[:-1, :])[0] + 1))
    if not xs or not ys:
        return None

    def share(e: np.ndarray, period: float) -> float:
        z = np.exp(2j * np.pi * e / period).mean()
        phase = (np.angle(z) / (2 * np.pi) * period) % period
        r = np.abs(((e - phase + period / 2) % period) - period / 2)
        return float((r <= 1.0).mean())

    ex, ey = np.array(xs, float), np.array(ys, float)
    best = None
    for period in np.arange(4, 60, 0.02):
        if min(share(ex, period), share(ey, period)) >= 0.95:
            best = period
    return BIG / best if best else None


def native_size(path: Path) -> tuple[float, float]:
    """(size, grey ratio): the font's own pixel grid when it has one, at the quarter size
    near it that renders cleanest; else the smallest size (6-40px) with no grey edges; else
    the cleanest size there is."""
    if n := grid_size(path):
        near = [q / 4 for q in range(round(n * 4) - 2, round(n * 4) + 3) if q >= 16]
        s, g = min(((s, grey_ratio(path, s)) for s in near), key=lambda t: (round(t[1], 2), abs(t[0] - n)))
        if g < 0.15:
            return s, g
    best = (12.0, 1.0)
    for q in range(24, 161):
        g = grey_ratio(path, q / 4)
        if g < 0.02:
            return q / 4, g
        if g < best[1] - 0.005:
            best = (q / 4, g)
    return best


# --- glyphs -------------------------------------------------------------------------------

@dataclass
class Glyph:
    img: Image.Image  # mode "1", ink only (trimmed); 1x1 blank for a space
    top: int          # rows of ink above the baseline (bbox top, negative = above)
    left: int


def render_glyph(f: ImageFont.FreeTypeFont, ch: str) -> Glyph | None:
    pad = 64
    img = Image.new("1", (pad * 2, pad * 2))
    d = ImageDraw.Draw(img)
    d.fontmode = "1"
    d.text((pad // 2, pad), ch, font=f, fill=1, anchor="ls")
    box = img.getbbox()
    if not box:
        return None
    return Glyph(img.crop(box), box[1] - pad, box[0] - pad // 2)


def notdef_set(f: ImageFont.FreeTypeFont) -> set[bytes]:
    out = set()
    for ch in ("", "\U0010fffd", "￾"):
        g = render_glyph(f, ch)
        out.add(g.img.tobytes() + bytes(g.img.size) if g else b"")
    return out


def has_glyph(f: ImageFont.FreeTypeFont, ch: str, notdef: set[bytes]) -> bool:
    if ch.isspace():
        return True
    g = render_glyph(f, ch)
    return g is not None and (g.img.tobytes() + bytes(g.img.size)) not in notdef


# --- the Kiosune sheet --------------------------------------------------------------------

@dataclass
class Sheet:
    name: str
    glyphs: dict[str, Glyph]  # in cell order
    cell_w: int
    cell_h: int
    baseline: int             # rows above the baseline
    space: int                # assumed width of a space when laying text out
    missing: list[str]

    @property
    def chars(self) -> str:
        return "".join(self.glyphs)

    def png(self, cols: int = COLS, colour=(255, 255, 255)) -> Image.Image:
        n = len(self.glyphs)
        rows = (n + cols - 1) // cols
        img = Image.new("RGBA", (cols * self.cell_w, rows * self.cell_h), (0, 0, 0, 0))
        ink = Image.new("RGBA", img.size, (*colour, 255))
        mask = Image.new("1", img.size)
        for i, (ch, g) in enumerate(self.glyphs.items()):
            if ch == " ":
                continue
            x = (i % cols) * self.cell_w
            y = (i // cols) * self.cell_h
            mask.paste(g.img, (x + max(0, g.left), y + self.baseline + g.top))
        img.paste(ink, (0, 0), mask)
        return img

    def settings(self) -> str:
        return (f"name      {self.name}\ncell      {self.cell_w} x {self.cell_h}\n"
                f"baseline  {self.baseline}\ncharacters ({len(self.glyphs)}):\n{self.chars}\n")

    # Kiosune's layout, as far as the dialog states it: each glyph trimmed to its ink.
    # The gap between glyphs and the width of a space are assumptions.
    GAP = 1

    def width(self, text: str) -> int:
        w = 0
        for i, ch in enumerate(text):
            g = self.glyphs.get(ch)
            w += self.space if ch == " " or g is None else g.img.size[0]
            if i < len(text) - 1:
                w += self.GAP
        return w

    def wrap(self, text: str, width: int) -> list[str]:
        rows: list[str] = []
        for para in text.split("\\n"):
            cur = ""
            for word in para.split():
                trial = f"{cur} {word}" if cur else word
                if self.width(trial) <= width or not cur:
                    cur = trial
                else:
                    rows.append(cur)
                    cur = word
            rows.append(cur)
        return rows

    def draw(self, img: Image.Image, xy: tuple[int, int], text: str, colour) -> None:
        """Draw text with its cell top at xy."""
        x, y = xy
        solid = Image.new("RGBA", (1, 1), (*colour, 255))
        for ch in text:
            g = self.glyphs.get(ch)
            if ch == " " or g is None:
                x += self.space + self.GAP
                continue
            w, h = g.img.size
            img.paste(solid.resize((w, h)), (x, y + self.baseline + g.top), g.img)
            x += w + self.GAP


def finish(name: str, glyphs: dict[str, Glyph], missing: list[str]) -> Sheet:
    ink = [g for ch, g in glyphs.items() if ch != " "]
    above = max(-g.top for g in ink)
    below = max(g.top + g.img.size[1] for g in ink)
    cell_w = max(g.img.size[0] + max(0, g.left) for g in ink)
    widths = sorted(g.img.size[0] for ch, g in glyphs.items() if ch.isalpha())
    space = max(2, widths[len(widths) // 2] // 2 + 1) if widths else 3
    if " " not in glyphs:
        glyphs = {" ": Glyph(Image.new("1", (1, 1)), 0, 0), **glyphs}
    return Sheet(name, glyphs, cell_w, above + max(0, below), above, space, missing)


def from_font(path: Path, chars: str, size: float | None = None,
              name: str | None = None) -> tuple[Sheet, float, float]:
    """(sheet, size, grey) for the characters the font has, at its native size."""
    if size is None:
        size, grey = native_size(path)
    else:
        grey = grey_ratio(path, size)
    f = ImageFont.truetype(str(path), size)
    notdef = notdef_set(f)
    glyphs: dict[str, Glyph] = {}
    missing = []
    for ch in dict.fromkeys(chars):
        if ch == " ":
            glyphs[ch] = Glyph(Image.new("1", (1, 1)), 0, 0)
        elif has_glyph(f, ch, notdef):
            glyphs[ch] = render_glyph(f, ch)
        else:
            missing.append(ch)
    # Glyphs keep their left bearing only when it is never negative; trimmed anyway.
    for g in glyphs.values():
        g.left = 0
    fam = f.getname()[0]
    return finish(name or fam, glyphs, missing), size, grey


# --- reading a sheet ----------------------------------------------------------------------

def ink_mask(img: Image.Image) -> Image.Image:
    """Ink as mode "1": opaque pixels on a transparent sheet, else pixels that differ from
    the most common colour (the background)."""
    rgba = img.convert("RGBA")
    alpha = rgba.getchannel("A")
    if alpha.getextrema()[0] < 128:
        return alpha.point(lambda v: 255 if v >= 128 else 0).convert("1")
    rgb = rgba.convert("RGB")
    bg = max(rgb.getcolors(1 << 24), key=lambda c: c[0])[1]
    px = rgb.load()
    out = Image.new("1", rgb.size)
    o = out.load()
    for y in range(rgb.height):
        for x in range(rgb.width):
            r, g, b = px[x, y]
            o[x, y] = abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) > 96
    return out


def detect_cell(mask: Image.Image) -> tuple[int, int]:
    """The cell size, from how ink is spread along each axis.  Fold the column (row) ink
    counts at a candidate width: at the true cell width every fold lines up, so the folded
    profile is lumpy; at a wrong width it smears flat.  Multiples of the true width are as
    lumpy, so take the smallest width whose profile is nearly as lumpy as the lumpiest.
    (Glyphs touching across cells, as in a tightly packed sheet, do not matter here.)"""
    a = np.asarray(mask, dtype=np.float64)

    def best(profile: np.ndarray) -> int:
        n = len(profile)
        cands = [s for s in range(3, n // 2 + 1) if n % s == 0 and n // s <= 64]
        if not cands:
            return n

        def lumpiness(s: int) -> float:
            folded = profile.reshape(-1, s).sum(0)
            return float(folded.std() / folded.mean()) if folded.mean() else 0.0
        score = {s: lumpiness(s) for s in cands}
        top = max(score.values())
        return next(s for s in cands if score[s] >= 0.75 * top)
    return best(a.sum(0)), best(a.sum(1))


def from_sheet(path: Path, order: str, cell: tuple[int, int] | None = None,
               name: str | None = None) -> Sheet:
    mask = ink_mask(Image.open(path))
    cw, ch_ = cell or detect_cell(mask)
    cols, rows = mask.width // cw, mask.height // ch_
    order = {"ascii": ASCII, "latin1": LATIN1}.get(order, order)
    cells = []
    for r in range(rows):
        for c in range(cols):
            cells.append(mask.crop((c * cw, r * ch_, (c + 1) * cw, (r + 1) * ch_)))
    while cells and not cells[-1].getbbox():
        cells.pop()
    glyphs: dict[str, Glyph] = {}
    for cell_img, chr_ in zip(cells, order):
        box = cell_img.getbbox()
        if chr_ == " " or not box:
            if chr_ == " ":
                glyphs[" "] = Glyph(Image.new("1", (1, 1)), 0, 0)
            continue
        glyphs[chr_] = Glyph(cell_img.crop(box), box[1], 0)  # top from the cell top for now
    # The baseline: the bottom row of most capitals and digits.
    bottoms = [g.top + g.img.size[1] for k, g in glyphs.items() if k.isupper() or k.isdigit()]
    base = max(set(bottoms), key=bottoms.count) if bottoms else ch_
    for g in glyphs.values():
        g.top -= base
    sheet = finish(name or path.stem, glyphs, [])
    return sheet


def proof(sheet: Sheet, scale: int = 4) -> Image.Image:
    """The grid at `scale`x, each cell captioned with the character it was assigned."""
    grid = sheet.png(colour=(20, 20, 24))
    cols = COLS
    cw, chh = sheet.cell_w * scale, sheet.cell_h * scale
    label = 14
    rows = (len(sheet.glyphs) + cols - 1) // cols
    out = Image.new("RGB", (cols * (cw + 4), rows * (chh + label + 4)), (246, 244, 238))
    d = ImageDraw.Draw(out)
    try:
        lf = ImageFont.load_default(size=11)
    except TypeError:
        lf = ImageFont.load_default()
    big = grid.resize((grid.width * scale, grid.height * scale), Image.NEAREST)
    for i, ch in enumerate(sheet.glyphs):
        c, r = i % cols, i // cols
        x, y = c * (cw + 4) + 2, r * (chh + label + 4) + 2
        d.rectangle((x, y, x + cw - 1, y + chh - 1), fill=(255, 255, 255), outline=(210, 206, 198))
        cellimg = big.crop((c * cw, r * chh, (c + 1) * cw, (r + 1) * chh))
        out.paste(cellimg, (x, y), cellimg)
        base_y = y + sheet.baseline * scale
        d.line((x, base_y, x + cw - 1, base_y), fill=(230, 120, 90))
        d.text((x + cw // 2, y + chh + 1), "␠" if ch == " " else ch, font=lf,
               fill=(60, 60, 70), anchor="ma")
    return out


# --- CLI ----------------------------------------------------------------------------------

SPEAKER = re.compile(r'^[~!+^_ ]*[A-Z][\w\'. ]*?(?:\s*\([^)]*\))?(?:\s+as\s+"[^"]*")?:\s')


def script_chars(path: Path) -> str:
    """Every character outside comments and directives in a .kio.txt script."""
    seen: dict[str, None] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith(("#", "@")):
            continue
        for ch in s:
            if not ch.isspace():
                seen[ch] = None
    return "".join(ch for ch in seen if ch not in ASCII)


def resolve_chars(spec: str, script: Path) -> str:
    if spec == "ascii":
        return ASCII
    if spec == "latin1":
        return LATIN1
    if spec == "script":
        return ASCII + (script_chars(script) if script.is_file() else "")
    return spec


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "font"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("source", help=".ttf/.otf font or .png glyph sheet")
    ap.add_argument("--name")
    ap.add_argument("--size", type=float, help="font: pixel size (default: native)")
    ap.add_argument("--chars", default="script", help="font: ascii | script | latin1 | text")
    ap.add_argument("--order", default="latin1", help="sheet: latin1 | ascii | the characters")
    ap.add_argument("--cell", help="sheet: cell size WxH (default: detected)")
    ap.add_argument("--script", default="", help="with --chars script: add every character this script uses")
    ap.add_argument("-o", "--outdir", default="out/kiosune-fonts")
    args = ap.parse_args()

    src = Path(args.source)
    if src.suffix.lower() in (".ttf", ".otf"):
        sheet, size, grey = from_font(src, resolve_chars(args.chars, Path(args.script)),
                                      args.size, args.name)
        note = f"{size:g}px" + ("" if grey < 0.02 else f", {grey:.0%} grey: not pixel-exact")
    elif src.suffix.lower() == ".png":
        cell = tuple(int(v) for v in args.cell.lower().split("x")) if args.cell else None
        sheet = from_sheet(src, args.order, cell, args.name)
        note = "sheet; check the proof"
    else:
        raise SystemExit("give a .ttf, .otf or .png")
    out = Path(args.outdir)
    out.mkdir(parents=True, exist_ok=True)
    stem = slug(sheet.name)
    sheet.png().save(out / f"{stem}.png")
    (out / f"{stem}.txt").write_text(sheet.settings(), encoding="utf-8")
    proof(sheet).save(out / f"{stem}-proof.png")
    print(sheet.settings(), end="")
    if sheet.missing:
        print(f"not in the font ({len(sheet.missing)}): {''.join(sheet.missing)}")
    print(f"({note})\n{out / (stem + '.png')}\n{out / (stem + '-proof.png')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
