# kiosune-tools

Unofficial tools for writing [Kiosune Studio](https://mellotoddtv.itch.io/kiosune-studio) scripts
by hand — the `⇄ text` format, in an editor instead of the studio.

*Not made by or affiliated with Kiosune Studio. The syntax these tools accept is the studio's
official [cheat sheet](https://kiosune.com/tutorials/script-cheat-sheet).*

| | |
|---|---|
| [`vscode-kiosune/`](vscode-kiosune/) | **VS Code extension**: highlighting, outline, hover, rename, flow checks as you type, and a scene map. |
| `kio-check` | The same flow checks on the command line, for CI and edit hooks. Exit 1 on any error. |
| `fx-diff` | Proves an effects pass only *added* effect lines (`@fx`, `@grade`, `@shake` …), and none in a spot where an extra line changes the story. |
| `kiosune-font` | Packs a pixel font (`.ttf`/`.otf`) or a glyph sheet into Kiosune's bitmap-font import. [`font_packer.html`](src/kiosune_tools/font_packer.html) does the same in a browser. |
| `kiosune-credits` | Credits, attributions, AI-use disclosure and your own terms, from one CSV. |

## The extension

Install **Kiosune Script (unofficial)** from the VS Code Marketplace or Open VSX, or a `.vsix` from the
releases. See [its README](vscode-kiosune/README.md) for everything it does.

## The command-line tools

With [uv](https://docs.astral.sh/uv/), in your own project:

```bash
uv add git+https://github.com/fortress-rhythm/kiosune-tools
uv run kio-check story.kio.txt
uv run kio-check story.kio.txt --progress     # + what is still unwritten, per section
uv run fx-diff before.kio.txt after.kio.txt
```

The font packer needs numpy and Pillow: add `kiosune-tools[font]` instead. Or run any tool once
without adding it:

```bash
uvx --from git+https://github.com/fortress-rhythm/kiosune-tools kio-check story.kio.txt
```

Each tool is also a single file you can copy into a project and run with `python`: `kio_check.py`
and `credits.py` need only the standard library, and `fx_diff.py` needs `kio_check.py` beside it.

## Two checkers, one set of rules

`kio-check` and the extension implement the same rules twice: the command line has to run with
nothing but Python, and the extension needs its own parser for everything else it does. The
corpus in [`tests/fixtures/kio/`](tests/fixtures/kio/) pins both to the same answers, so a rule
changed in one fails the other's tests until it changes too. Read its README before changing a
rule.

```bash
uv sync && uv run pytest                                 # Python
cd vscode-kiosune && npm install && npm test             # extension
```

[`examples/lamp-room.kio.txt`](examples/lamp-room.kio.txt) is a small script that uses most of the
format; the extension's tests run against it, and it must always pass both checkers.

## Licence and credits

[MIT](LICENSE). Credits and the AI-use statement are in [`credits.csv`](credits.csv):

```bash
uv run kiosune-credits render credits.csv --scope tools --format md
```
