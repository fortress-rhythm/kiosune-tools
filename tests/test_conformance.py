"""Both checkers must agree on the shared corpus — see tests/fixtures/kio/README.md.

`kio_check` and the VS Code extension implement the same rules twice, so this
pins the rules to files rather than to either implementation. The extension's half of the
contract lives in `vscode-kiosune/test/corpus.test.js` and reads the same `expected.json`.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
CORPUS = ROOT / "tests" / "fixtures" / "kio"
from kiosune_tools import kio_check  # noqa: E402

#: How a kio_check message maps onto the shared vocabulary. First match wins.
RULE_BY_MESSAGE: tuple[tuple[str, str], ...] = (
    ("duplicate @label", "duplicate-label"),
    ("target does not resolve", "target-unresolved"),
    ("seen() on an auto-generated label", "generated-label-gate"),
    ("blank line or comment inside a choice", "choice-interrupted"),
    ("choice has no options", "choice-empty"),
    ("every option is conditional", "choice-all-conditional"),
    ("timer targets option", "timer-index"),
    ("above the timer's target", "timer-index"),
    ("@when is followed by a comment or blank line", "guard-orphan"),
    ("@when directly followed by another @when", "guard-chain"),
    ("narration contains a colon without a leading", "unprefixed-colon"),
    ("but never read", "variable-never-read"),
    ("but never written", "variable-never-written"),
    ("is unreachable from the first line", "unreachable"),
    ("route falls off the end of the file", "falls-off-end"),
    ("@return reached without a @call", "return-without-call"),
    ("malformed markup", "markup-malformed"),
    ("is not an entrance or exit motion", "motion-unknown"),
    ("is not a place", "place-unknown"),
    ("comment on a directive line", "directive-comment"),
    ("@adv takes no argument", "adv-argument"),
    ("plate after the expression", "plate-order"),
)

EXPECTED = json.loads((CORPUS / "expected.json").read_text(encoding="utf-8"))
SHARED = set(EXPECTED["rules"])


def shared_rules(path: Path) -> set[str]:
    """The findings kio_check reports for `path`, as shared rule names."""
    script = kio_check.load(str(path))
    err, warn, _ = kio_check.check(script, str(path))
    found = set()
    for message in (*err, *warn):
        for needle, rule in RULE_BY_MESSAGE:
            if needle in message:
                found.add(rule)
                break
    return found & SHARED


def test_vocabulary_is_consistent() -> None:
    assert {rule for _, rule in RULE_BY_MESSAGE} == SHARED, "the mapping and expected.json disagree"
    covered = {rule for rules in EXPECTED["fixtures"].values() for rule in rules}
    assert covered == SHARED, f"no fixture covers {sorted(SHARED - covered)}"


def test_every_fixture_has_a_row() -> None:
    on_disk = {p.name for p in CORPUS.glob("*.kio.txt")}
    assert on_disk == set(EXPECTED["fixtures"]), "add the new fixture to expected.json"


@pytest.mark.parametrize("name", sorted(EXPECTED["fixtures"]))
def test_kio_check_matches_the_corpus(name: str) -> None:
    assert sorted(shared_rules(CORPUS / name)) == EXPECTED["fixtures"][name]
