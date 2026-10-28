"""kiosune_tools/credits.py: one CSV in, credits and an honest AI answer out."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

from kiosune_tools import credits  # noqa: E402
from kiosune_tools.credits import blank_row, check, disclosure, fill_pexels, load, render, save  # noqa: E402


def sample() -> list[dict[str, str]]:
    rows = [
        blank_row("meta", scope="both", name="title", notes="Test Game"),
        blank_row("meta", scope="both", name="disclaimer", notes="Not exhaustive."),
        blank_row("asset", kind="photo", my_name="Hall", by="A. Person",
                  url="https://www.pexels.com/photo/1/"),
        blank_row("asset", kind="music", my_name="Theme", by="B", url="https://b.example",
                  license="CC BY 4.0", license_url="https://creativecommons.org/licenses/by/4.0/"),
        blank_row("framework", kind="engine", name="Engine", by="Dev", thanks="Thanks!"),
        blank_row("tool", scope="tools", kind="code", name="Helper", include="no"),
        blank_row("ai", scope="game", kind="graphics", ai="process", role="tuned a filter"),
        blank_row("ai", scope="tools", kind="code", ai="ships", role="wrote the tools"),
        blank_row("terms", scope="game", kind="game", name="The game", by="Me",
                  license="All rights reserved"),
    ]
    for r in rows:
        fill_pexels(r)
    return rows


def test_pexels_fills_licence_from_the_url():
    hall = sample()[2]
    assert (hall["site"], hall["license"], hall["cost"]) == ("Pexels", "Pexels License", "free")
    assert "photo by A. Person on [Pexels](https://www.pexels.com/photo/1/)" in render(sample())


def test_fill_pexels_keeps_what_you_wrote():
    r = blank_row("asset", url="https://www.pexels.com/photo/2/", license="Custom deal")
    fill_pexels(r)
    assert r["license"] == "Custom deal"


def test_scope_separates_the_game_from_the_tools():
    rows = sample()
    assert disclosure(rows, "game") == ([], ["graphics"])
    assert disclosure(rows, "tools") == (["code"], [])
    assert disclosure(rows, "all") == (["code"], ["graphics"])
    game = render(rows, "game")
    assert "No generative-AI output is part of the game. AI was used along the way for: graphics." in game
    assert "wrote the tools" not in game
    assert "Generative AI output is part of the tools: code." in render(rows, "tools")


def test_hidden_ai_rows_still_count_for_disclosure():
    rows = sample()
    rows[-2]["include"] = "no"                    # hide the tools' code row
    assert disclosure(rows, "tools")[0] == ["code"]
    assert "wrote the tools" not in render(rows, "tools")
    assert "part of the tools: code" in render(rows, "tools")


def test_include_no_keeps_a_row_out_of_print():
    assert "Helper" not in render(sample(), "all")


def test_check_flags_blanks_and_missing_licences():
    rows = sample()
    rows.append(blank_row("asset", kind="sound", by="C", url="https://c.example"))
    rows.append(blank_row("terms", name="Code", license="___"))
    rows.append(blank_row("ai", kind="vibes", ai="maybe", role="x"))
    problems = "\n".join(check(rows))
    assert "no licence or terms" in problems
    assert "___" in problems
    assert "category must be one of" in problems
    assert "ships or process" in problems
    assert check(sample()) == []


def test_every_format_renders_the_disclaimer_last():
    for fmt in credits.FORMATS:
        out = render(sample(), "game", fmt).strip()
        assert out.splitlines()[-1].endswith(("Not exhaustive.*", "Not exhaustive.",
                                              "Not exhaustive.</em></p>"))


def test_html_escapes():
    rows = [blank_row("framework", name="A <b> & co")]
    assert "A &lt;b&gt; &amp; co" in render(rows, "game", "html")


def test_csv_round_trip_keeps_unknown_columns(tmp_path: Path):
    rows = sample()
    rows[0]["my_column"] = "kept"
    path = tmp_path / "c.csv"
    save(path, rows)
    assert path.read_bytes().startswith(b"\xef\xbb\xbf")        # BOM for Excel
    again = load(path)
    assert again[0]["my_column"] == "kept"
    assert [r["name"] for r in again] == [r["name"] for r in rows]


def test_project_csv_has_no_errors_except_unchosen_licences():
    rows = load(ROOT / "credits.csv")
    for r in rows:
        fill_pexels(r)
    assert all("still has a ___" in p and "terms" in p for p in check(rows))
