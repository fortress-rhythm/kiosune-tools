# kiosune-tools — working notes for Claude

Public, MIT, by fortress-rhythm. Unofficial tools for Kiosune Studio scripts: the VS Code extension
in `vscode-kiosune/` and the Python commands in `src/kiosune_tools/` (`kio-check`, `fx-diff`,
`kiosune-font`, `kiosune-credits`). The official
[cheat sheet](https://kiosune.com/tutorials/script-cheat-sheet) is the authority on syntax.

## Commands

```bash
uv sync && uv run pytest                                  # Python tests
cd vscode-kiosune && npm install && npm test              # extension tests (+ grammar tests)
uv run kio-check examples/lamp-room.kio.txt               # flow check
cd vscode-kiosune && npx @vscode/vsce package             # build the .vsix
```

## Rules

- **Two checkers, one set of rules.** `kio-check` is the command line, hooks and CI; the extension
  is the editor, and it checks more besides (undeclared names, markup, unknown directives). Change
  a rule in one and you must change it in the other: `tests/fixtures/kio/` pins both to the same
  fixtures, so `uv run pytest` and `npm test` both fail until they agree. Read its README first.
  Never loosen an expectation to make a suite pass.
- `examples/lamp-room.kio.txt` must pass both checkers with nothing to report; the extension's
  tests run against it.
- `kio_check.py` and `credits.py` stay standard-library only, and every module still runs as a
  loose script (`fx_diff.py` falls back to a sibling `kio_check.py`).
- This repo is public. Nothing from a private game goes in: no script lines, names or assets
  beyond the synthetic fixtures. Keep "unofficial / not affiliated with Kiosune Studio" visible.
- `credits.csv` rows marked REVIEW are the author's public statement: never soften an AI row.
- User-facing changes get a line in `CHANGELOG.md` (Python) or `vscode-kiosune/CHANGELOG.md`.
- The user is on Windows and uses uv. Give `uv run …` commands.
