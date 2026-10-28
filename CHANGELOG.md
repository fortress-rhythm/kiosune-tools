# Changelog

The Python tools (`kio-check`, `fx-diff`, `kiosune-font`, `kiosune-credits`). The VS Code
extension keeps its own, in [`vscode-kiosune/CHANGELOG.md`](vscode-kiosune/CHANGELOG.md).
Versions follow [Semantic Versioning](https://semver.org/).

## [0.1.0] — unreleased

First public release.

- `kio-check`: the static flow check — labels and targets, choice shape, timers, guards,
  variables read but never written (and the reverse), reachability, routes that fall off the end,
  subroutines, markup, stage motions. `--progress` for a burn-down of blanks and anchors,
  `--audio` for the open `# SOUND:` list.
- `fx-diff`: proves an effects pass only inserted effect lines, and none of them in an insertion
  trap. `--tier2` also allows timing and colour tweaks on existing lines.
- `kiosune-font`: packs a pixel font or a glyph sheet into Kiosune's bitmap-font import, with a
  proof sheet. `font_packer.html` is the same packer as a page.
- `kiosune-credits`: credits, attributions, AI-use disclosure and your own terms from one CSV,
  rendered as Markdown, text or HTML, with a small editor.
