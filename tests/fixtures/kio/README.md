# The shared check corpus

Two things check a Kiosune script in this repo: `kio_check`, which edit hooks and the test
suite run, and the VS Code extension in `vscode-kiosune/`, which runs in the editor as you
type. Neither can replace the other — the hook and CI must work with nothing but `uv`, and the
extension needs its own parser anyway for hover, completion and the scene map — so the same rules
are implemented twice, and twice means drift.

This corpus is what stops the drift. Each `.kio.txt` here makes exactly one mistake (or none), and
`expected.json` says which rules should fire. Both checkers are tested against it:

```bash
uv run pytest tests/test_conformance.py                       # the Python side
cd vscode-kiosune && node --test test/corpus.test.js          # the extension side
```

## The contract

`expected.json` lists the **shared vocabulary** — the rules both checkers implement — and, per
fixture, which of them should fire. Each side maps its own output onto those names: the Python by
message text, the extension by its diagnostic code.

What the contract covers is *which rules fire on which file*. It deliberately does not cover:

- **Severity.** The Python calls an all-conditional choice an error; the extension calls it a
  warning. That is each tool's own judgement about how loudly to speak.
- **Line numbers.** For a shifted timer index the Python points at the offending option and the
  extension points at the `[timer]` tag. Both are defensible; the fixtures are small enough that
  the rule firing at all is unambiguous.
- **Rules only one side has.** The extension also reports undeclared names, unbalanced markup,
  unknown directives, dead code after a jump and unwritten `___`; the Python also reports labels
  that are never targeted, and has the `--audio` pass. Those are invisible to this comparison.

## Adding to it

Add a fixture whenever a rule changes or a bug turns up, and give it the smallest script that
provokes exactly one thing. Then add its row to `expected.json`, and make **both** suites pass
before committing. If only one side can be made to agree, that is the finding: say so rather than
loosening the expectation.

The clean fixtures matter as much as the broken ones. `clean`, `stop-audio`, `random-inline`,
`import-rows` and `end-then` all exist because a checker once reported something on a correct
script — a `@stop music 1500` read as the end of a route, `@random:` rows read as a dead end, an
`@import` glob read as an unclosed italic, a `[then label]` ending read as unreachable.
`plate-order` is the one the studio rejects (`Name (expr) as "plate":`, tested 2026-10-16);
`plate-reference` holds a converted script's plate (`Anna as "{var=REF}" (sad):`, the order the
studio takes) and the header's References row that maps the placeholder to its variable; and
`condition-not-group` exists because the extension once read `not (` as a call and looped forever.
`subroutine` is the same story: the extension read `@call x return y` as falling through, which
left `y` unreachable. `clean-stage` holds the look-alikes for the vocabulary rules: `#hex` colours
that are not comments, `x,y` places, a `{color=#…}` tag, a bare `@adv`.
