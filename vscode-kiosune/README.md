# Kiosune Script — a VS Code extension

Kiosune Studio's `⇄ text` format is a screenplay: plain text, round-trips losslessly, and is the
one place you can write a whole visual novel with an editor instead of a mouse. It is also plain
text, so VS Code shows it as an undifferentiated grey wall, and the three mistakes that cost you a
build day — a blank line inside a choice, a timer index shifted by a hidden option, a `seen()` on a
label a re-export renumbered — look exactly like correct script.

This extension makes the format legible and checks it while you type.

*Unofficial: a community extension, not made by or affiliated with Kiosune Studio.*

- **Highlighting** that separates the three layers of the format: what the player reads, what the
  engine does, and what you have not written yet.
- **The structure, as data.** Labels, variables, cast, backgrounds, audio cues, endings and every
  `___` still to write, in the sidebar, in the outline, and on hover.
- **Flow checks** — the static half of the studio's `✓ check`, plus the traps that only bite when
  you author by hand. They run as you type.
- **A scene map:** the whole graph, laid out, coloured by background, clickable, exportable.

Nothing here talks to the studio or to the network. It reads the file in front of it and nothing
else.

## Install

Search for **Kiosune Script (unofficial)** in the Extensions view (VS Code Marketplace, or Open VSX for
VSCodium and Cursor). Or install a `.vsix` from the
[releases](https://github.com/fortress-rhythm/kiosune-tools/releases): Extensions view → `···` →
*Install from VSIX…*.

The extension has no build step and no runtime dependencies. To hack on it, open `vscode-kiosune/`
and press <kbd>F5</kbd>: the launch configuration opens a second window with the extension loaded
and `examples/lamp-room.kio.txt` open.

## Which files it applies to

Automatically:

- anything named `*.kio.txt`, `*.kio` or `*.kiosune`
- any file whose first line looks like a Kiosune script (`# … Kiosune …`, `@scene`, `@label`) —
  which covers a bare `.txt` export straight out of the studio

For anything else, run **Kiosune: Treat This File as a Kiosune Script** from the command palette,
or click the language name in the status bar and pick *Kiosune Script*. To make it stick for a
whole project, put this in `.vscode/settings.json`:

```json
{ "files.associations": { "script-*.txt": "kiosune" } }
```

## What you get

### Reading

| | |
|---|---|
| Highlighting | Speakers, expressions, backgrounds, labels, jump targets, variables, conditions, tags, `{pause=600}` / `{color=#hex}` markup, and `___` placeholders — each its own colour, in both TextMate and semantic passes. Prose stays prose: dialogue and narration keep the editor's plain foreground so the writing reads as writing. |
| Outline & breadcrumbs | `== chapters` → `@label` blocks → choices and endings. |
| Folding | By chapter, by label block, by choice, and over the comment header. |
| Hover | On a label: which background is on screen there, who is on stage (or every version, if the routes in disagree), how many ways in and from where, what it leads to. On a variable: its type, every write with its operator, whether anything ever reads it. On a directive or `[tag]`: what it does and the trap it carries. |
| Go to definition / references / rename | Labels and variables, everywhere they appear — including inside `seen()`, `[set …]` and router rows. Rename a label and every `@jump`, option arrow, `@if … else`, switch case and `seen()` follows. |
| Inlay hints | `12 in` at the end of each `@label`, so a hub is visible as a hub. |
| Completion | Directives with their signatures, labels after `->`, variables inside conditions, the cast after `@show`, that character's own expressions after `as`, declared backgrounds after `@scene`, audio cues, and the `[tags]`. |

### The sidebar

Four views under the Kiosune icon:

- **Story** — every block grouped by the background that is on screen when it runs, with its exits
  underneath. This is the threading, in a tree.
- **Variables** — each one with its type, its writes (with operators) and its reads, flagged when
  it is undeclared, never read, never written or unused.
- **Cast & assets** — characters with the expressions they actually use, backgrounds with where
  they are set, audio cues, and the endings with their keys.
- **Still to write** — every `___` grouped by block, and every `# BEAT:` / `# STATE:` / `# FX:` /
  `# SOUND:` note grouped by kind.

The status bar keeps a count: `128 to write`. Click it to run the checks; **Kiosune: Go to Next
Placeholder** walks them.

### The scene map

**Kiosune: Show Scene Map** (also the editor-title button) opens the graph beside the script:

- one box per block, coloured down its left edge by the background that is on screen there
- solid arrows for jumps and options, amber for conditional ones, dashed where a block simply runs
  on into the next label, purple boxes for endings, a dashed outline for anything nothing reaches
- hover a block to spotlight it and everything it touches; click one to jump to that line; the
  block your cursor is in stays highlighted as you edit
- filter by name or background, hide fall-through edges, hide the hub returns that would otherwise
  cross everything
- **stage** swaps each box's background line for who is on stage where the block starts
  (`Mara L · Tobin R`), carried along the routes in, since the stage is state and not a place
  in the file. Orange `stage varies ×3` means the routes in leave different stages; the block's
  tooltip lists every version, and what the block's own stage lines turn them into. A view only:
  it raises no diagnostic. (A plain `@call` continues with the caller's stage.)
- **Export SVG** writes `<script>-scene-map.svg` next to the script, with the colours baked in so
  it opens anywhere

The map redraws as you type.

### The checks

Diagnostics appear in the Problems panel with a code you can search for.

| Code | Severity | What it catches |
|---|---|---|
| `choice-interrupted` | error | A blank line or a comment between a `?` and its options. This ends the choice on import and the options below become narration — the single most common import bug. |
| `unknown-label`, `duplicate-label` | error | A `->`, `@jump`, `@call`, `return`, `seen()` or switch case with nowhere to land; two labels with one name. |
| `row-no-target` | error | A `@router` or `@switch` row with no `->`. |
| `timer-index` | warning | `[timer 9000 3]` picks option 3 *by position*. Flagged when a conditional option sits above the target (hiding it shifts the index) or when the index is out of range. |
| `generated-label-gate` | warning | `seen(l_42)` on an exported label name. A re-export renumbers it and the unlock breaks silently. |
| `unprefixed-colon` | warning | A line whose text before a colon would import as a junk character. Narration containing a colon must start with `:`. |
| `guard-stolen`, `guard-orphan`, `guard-chain` | warning | `@when` guards **only the next line**. An FX line inserted after it steals the guard. |
| `fx-splits-stage` | warning | An effect line between the stage lines and their `@transition`, which splits one stage change into two. |
| `unreachable`, `falls-off-end` | warning | A block nothing leads to; a route that runs off the end without `@end`, `@jump` or `@stop`. |
| `return-without-call` | warning | A `@return` the story reaches by a jump, an option, a branch or a fall-through rather than a `@call`, so it has no caller. Typically a choice pointing straight at a subroutine, or a route running on into the subroutines at the bottom of the file. |
| `place-unknown`, `motion-unknown` | warning | A place that is not `farleft left center right farright offscreen` or `x,y` (they are lowercase: `at Right` is flagged); an `enter`/`exit` motion that is not `fade slideleft slideright drop rise` (`enter flash` is a transition, not a motion). |
| `directive-comment` | warning | `@show Mara at left # FX: note`. A `#` after a command is read as part of it. `#hex` colours are not comments, and free-text directives (`@caption`, `@end`, …) are left alone. |
| `adv-argument` | warning | `@adv clear`. The cheat sheet has `@nvl [clear]` but a bare `@adv`. |
| `choice-all-conditional` | warning | Every option behind an `[if]`, so the menu can come up empty and dead-end. |
| `undeclared-variable`, `undeclared-background` | warning | A name that is not in the declarations at the top of the file. Unknown names import empty. |
| `variable-never-written` | warning | Read everywhere, written nowhere: it always has its default. |
| `unbalanced-markup` | warning | An unclosed `{color=…}`, an odd `*`, a stray brace. |
| `markup-malformed` | warning | `{pause 100}`: a `pause`, `speed`, `color` or `var` tag without its `=`. |
| `unknown-directive` | warning | A directive this extension does not know. Add yours to `kiosune.extraDirectives`. |
| `after-terminal` | info | Lines sitting after a `@jump`, `@end` or an exhaustive `@router`, which never run. |
| `variable-never-read`, `variable-unused`, `variable-shadows-directive` | info | Vestigial state, and variables named after a command (`hide` next to `@hide`). |
| `else-not-last`, `router-no-else`, `duplicate-option`, `ending-unnamed` | info | Rows that can never win; a router that falls through when nothing matches; the same option text twice; a bare `@end`, which gives up the Endings screen and the ending key. |
| `placeholder` | hint | Where the writing still has to happen. |

**Kiosune: Check Script** writes the same findings to an output channel with a word count and a
structural summary — the thing to paste into a progress note.

These are static checks over one file. They do not replace the studio's own `✓ check` or a
playtest of each route with the debug overlay on: what `keep` actually carries, whether a caption
survived, and how an effect looks over the art are all runtime questions.

## Declaring cast, backgrounds and variables

The checks that catch typos (`undeclared-background`, an unknown speaker) need to know what exists.
The extension reads declarations two ways.

A header comment block, which is what `examples/lamp-room.kio.txt` uses and what the studio's
import notes ask for:

```
# CREATE IN THE PROJECT BEFORE IMPORTING (import matches by name; unknown names import empty)
#   Backgrounds  Harbour · dusk  ·  Lighthouse · stairs  ·  Lighthouse · lamp room
#   Cast         Mara, Tobin, Radio
#   Variables    turns number 0..12 · trust number 0..100 · oil number 0..3
#                hasKey flag · askedName flag · late flag
```

Or explicit pragmas, which are unambiguous and survive reformatting. Backgrounds are
pipe-separated because their names contain `·`:

```
#! cast: Mara, Tobin, Radio
#! backgrounds: Harbour · dusk | Lighthouse · stairs | Lighthouse · lamp room
#! variables: trust number, late flag, oil number
```

Both are comments, so they round-trip through the studio untouched. Declare nothing and the
name-matching checks stay quiet; everything else still runs.

## Settings

| Setting | Default | |
|---|---|---|
| `kiosune.diagnostics.enabled` | `true` | Turn every check off. |
| `kiosune.diagnostics.placeholders` | `hint` | `off`, `hint`, `information`, `warning`. |
| `kiosune.diagnostics.unprefixedColon` | `warning` | `off`, `hint`, `warning`. |
| `kiosune.diagnostics.unknownDirective` | `warning` | `off`, `hint`, `warning`. |
| `kiosune.diagnostics.unusedVariables` | `true` | Written-never-read and read-never-written. |
| `kiosune.extraDirectives` | `[]` | Directive names your studio build has and this extension does not. |
| `kiosune.placeholderToken` | `___` | If you mark unwritten text some other way (`TKTK`). |
| `kiosune.decorations.placeholders` | `true` | The dashed underline under each placeholder. |
| `kiosune.inlayHints` | `true` | The `n in` counts on labels. |
| `kiosune.sceneMap.showFallthrough` | `true` | Initial state of the fall-through toggle, and what an exported SVG contains. |
| `kiosune.sceneMap.followCursor` | `true` | Highlight the block your cursor is in. |

## What it knows about the language

Every signature comes from the official
[cheat sheet](https://kiosune.com/tutorials/script-cheat-sheet); the practice around them — what a
construct is for and how it fails — comes from the
[script language guide](https://kiosune.com/tutorials/script-language) and from testing in the
studio. All 40 directives on
the sheet are covered:

- **text** — `== chapters`, `#` comments and `#!` pragmas, narration with and without the `:`
  prefix, `Name (expression) as "plate":` dialogue, the `~ ! + ^ _` style prefixes, and the inline
  markup `*i*`, `**b**`, `{color=…}`, `{pause=…}`, `{speed=…}`, `{var=…}`
- **choices** — `?` with `[timer ms [n] [fill] [nobar] [nopause]]` and `[mark]`; options with
  `[-> label]`, `[if]`, `[set a = 1; b += 2]`, `[grey "hint"]`, `[icon]`
- **flow** — `@label`, `@jump`, `@call … return`, `@return`, `@stop` (bare, and the audio form),
  `@end … [hidden] [key] [card] [notitle] [color] [then label]`, `@if … else`, `@when`, `@router`
  with rows, `@switch`, and `@random:` inline
- **state** — `@set` with `=`, `+=`, `-=`, `*=`, `/=`, `%+=`, `%-=`; `@toggle`; `@input … [max]
  [default]`; `@export` and `@import` with their glob rows
- **stage** — `@scene … [keep] | kind ms`, `@show` / `@move` / `@hide` / `@clear` with places,
  expressions, parts, `flip`, `dim`, `z`, `enter` and `exit`; `@transition`, `@caption`,
  `@overlay`, `@insert`, `@beat`
- **effects and audio** — `@fx show|move|hide|clear`, `@grade`, `@effect`, `@shake`, `@flash`;
  `@music`, `@ambience`, `@sfx`, `@voice`
- **interface** — `@nvl`, `@adv`, `@channel`, `@ui`, `@wait`

Conditions take `= != < <= > >=` with `and or not ( )`, over numbers, quoted text, `yes`/`no`,
variables, `visited(label)`, `seen(label)` and `random(min,max)`. Completion also knows the closed
vocabularies — places, motions, transitions, engine effects, fx layers and the 22 built-in fx ids.

Unknown directives are a warning, never an error, and `kiosune.extraDirectives` silences them for a
build newer than this extension. Where a form is ambiguous the extension is lenient: it reports and
carries on parsing.

## Developing

```bash
node --test test/*.test.js     # no install needed
npm install && npm test        # + the tests that tokenise with VS Code's own TextMate engine
```

`test/corpus.test.js` is half of a contract: the repository's Python `kio-check` implements the
same rules for the command line, edit hooks and CI, and both are tested against the fixtures in
`tests/fixtures/kio/` so they cannot drift apart. Read that folder's README before changing a rule
here — the other side has to change with it.

The model is pure and lives in four files — `parser.js`, `graph.js`, `check.js`, `svg.js` — none of
which import `vscode`, so they are testable in plain node and the same graph feeds the map, the
checks and the sidebar. `test/vscode-stub.js` is enough of the editor API to activate the extension
and call its providers, which is how the provider tests run here.

```
src/
  parser.js      text → model (lines, labels, variables, cast, choices, placeholders)
  graph.js       model → blocks and the edges between them, plus the layered layout
  check.js       model + graph → findings
  svg.js         layout → SVG, for the webview and for export
  directives.js  what each @directive means, and the trap it carries
  locate.js      what the cursor is on
  providers.js   the language features
  views.js       the four sidebar trees
  scenemap.js    the webview panel
  extension.js   activation, diagnostics, decorations, status bar, commands
media/           the webview's own CSS and JS, and the icons
syntaxes/        the TextMate grammar
```
