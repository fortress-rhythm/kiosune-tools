"""Credits, attributions, AI-use notes and your own terms, kept in one CSV.

Standard library only (csv + tkinter), one file: copy it into any project,
Kiosune or otherwise, and run it there.

    kiosune-credits gui [credits.csv]
    kiosune-credits render credits.csv --scope game --format md -o CREDITS.md
    kiosune-credits check credits.csv --scope game
    kiosune-credits init new-credits.csv

One CSV row per credit.  ``section`` says what a row is:

* ``meta``      project facts: ``name`` is the key, ``notes`` the value
                (title, author, author_url, year, intro, ai_note, disclaimer)
* ``asset``     photos, art, music, sound, fonts made by someone else
* ``tool``      what you used to make things, and what for
* ``framework`` engines, frameworks, plugins, studios; ``thanks`` adds a line
* ``ai``        generative AI use: ``kind`` is the itch.io category, ``ai`` is
                ``ships`` (its output is in the product) or ``process`` (it
                helped, nothing it produced is in the product)
* ``terms``     your own licence and terms, per part of the release

``scope`` is ``game``, ``tools`` or ``both``, so the game you made and the
tools you made it with can be credited — and disclosed — separately.  Set
``include`` to ``no`` to keep a row for reference without printing it.  An
``ai`` row set to ``no`` still counts towards the disclosure line: hiding the
detail never hides the fact.
"""

from __future__ import annotations

import argparse
import csv
import html
import re
import sys
from dataclasses import dataclass
from pathlib import Path

COLUMNS = ["section", "include", "scope", "kind", "name", "my_name", "by", "by_url",
           "url", "site", "license", "license_url", "cost", "role", "ai", "thanks", "notes"]

SECTIONS = ["meta", "asset", "tool", "framework", "ai", "terms"]
SCOPES = ["game", "tools", "both"]
RENDER_SCOPES = ["game", "tools", "all"]
FORMATS = ["md", "txt", "html"]

# itch.io's disclosure form asks about exactly these four, plus a free answer.
AI_KINDS = {"graphics": "graphics", "sound": "sound", "text": "text & dialogue",
            "code": "code", "other": "other"}
AI_USES = ["ships", "process"]

PEXELS_LICENSE = ("Pexels License", "https://www.pexels.com/license/")

LICENSES = ["All rights reserved", "Pexels License", "CC0 1.0", "CC BY 4.0", "CC BY-SA 4.0",
            "CC BY-NC 4.0", "CC BY-NC-SA 4.0", "MIT", "Apache-2.0", "GPL-3.0", "Unlicense",
            "Free to use (see terms)", "Commercial licence (paid)"]

META_KEYS = {
    "title": "Title",
    "author": "Your name (as credited)",
    "author_url": "Your website",
    "year": "Year",
    "intro": "Opening line",
    "ai_note": "How you used generative AI (free text, printed under AI use)",
    "disclaimer": "Disclaimer (printed last)",
}

DEFAULT_DISCLAIMER = (
    "External assets, tools and frameworks are credited here where their licences require it, "
    "and wherever I wanted to say thanks. This is not an exhaustive list of every tool, "
    "reference or inspiration that went into the work.")

PLACEHOLDER = "___"


@dataclass(frozen=True)
class Field:
    key: str
    label: str
    choices: tuple[str, ...] = ()
    multiline: bool = False


# What each section shows in the GUI, in order.  Columns a section leaves out
# stay in the CSV untouched.
_COMMON = (Field("include", "Include", ("yes", "no")), Field("scope", "Scope", tuple(SCOPES)))
FIELDS: dict[str, tuple[Field, ...]] = {
    "asset": _COMMON + (
        Field("kind", "Type", ("photo", "graphic", "music", "sound", "font", "video", "other")),
        Field("my_name", "What I call it / where it's used"),
        Field("name", "Original title"),
        Field("by", "By"), Field("by_url", "Their website"),
        Field("url", "Source page"), Field("site", "Site", ("Pexels", "Unsplash", "itch.io",
                                                          "freesound.org", "OpenGameArt")),
        Field("license", "Licence / terms", tuple(LICENSES)), Field("license_url", "Licence link"),
        Field("cost", "Cost", ("free", "paid", "other")),
        Field("notes", "Notes", multiline=True)),
    "tool": _COMMON + (
        Field("kind", "Used for", ("transform art", "transform other", "make art", "audio",
                                   "writing", "code", "research", "other")),
        Field("name", "Tool"), Field("role", "What it did here"),
        Field("by", "By"), Field("by_url", "Their website"), Field("url", "Tool website"),
        Field("ai", "Generative AI?", ("no", "yes")),
        Field("notes", "Notes", multiline=True)),
    "framework": _COMMON + (
        Field("kind", "Type", ("engine", "framework", "plugin", "library", "studio", "platform",
                               "event")),
        Field("name", "Name"), Field("by", "By"), Field("by_url", "Their website"),
        Field("url", "Website"), Field("license", "Licence", tuple(LICENSES)),
        Field("thanks", "Thanks (blank = just list it)", multiline=True),
        Field("notes", "Notes", multiline=True)),
    "ai": _COMMON + (
        Field("kind", "itch.io category", tuple(AI_KINDS)),
        Field("ai", "Output in the product?", tuple(AI_USES)),
        Field("name", "Model / tool"), Field("by", "By"), Field("url", "Website"),
        Field("role", "What it did (public)", multiline=True),
        Field("notes", "Private notes (never printed)", multiline=True)),
    "terms": _COMMON + (
        Field("kind", "Applies to", ("all", "game", "code", "assets", "music", "writing")),
        Field("name", "Covers (e.g. 'the game', 'tools/ source')"),
        Field("by", "Copyright holder"),
        Field("license", "Licence", tuple(LICENSES)), Field("license_url", "Licence link"),
        Field("notes", "Terms in your words", multiline=True)),
}

TAB_NAMES = {"asset": "Assets", "tool": "Tools", "framework": "Frameworks", "ai": "AI use",
             "terms": "Terms"}
SECTION_TITLES = {"asset": "Photos, art and audio", "tool": "Tools", "framework":
                  "Engines and frameworks", "ai": "Generative AI", "terms": "Licence and terms"}


# ---------------------------------------------------------------- data

def blank_row(section: str, **values: str) -> dict[str, str]:
    row = dict.fromkeys(COLUMNS, "")
    row.update(section=section, include="yes", scope="game")
    row.update(values)
    return row


def load(path: Path) -> list[dict[str, str]]:
    """Rows from the CSV, every column present.  Unknown columns are kept."""
    with path.open(encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    return [{**dict.fromkeys(COLUMNS, ""), **{k: (v or "") for k, v in r.items() if k}}
            for r in rows]


def save(path: Path, rows: list[dict[str, str]]) -> None:
    """utf-8 with a BOM, so Excel on Windows reads · and é correctly."""
    extra = [k for r in rows for k in r if k not in COLUMNS]
    fields = COLUMNS + list(dict.fromkeys(extra))
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, lineterminator="\n")
        w.writeheader()
        w.writerows(rows)


def template() -> list[dict[str, str]]:
    return ([blank_row("meta", scope="both", name=k, notes="") for k in META_KEYS if k != "disclaimer"]
            + [blank_row("meta", scope="both", name="disclaimer", notes=DEFAULT_DISCLAIMER)])


def meta(rows: list[dict[str, str]]) -> dict[str, str]:
    return {r["name"]: r["notes"] for r in rows if r["section"] == "meta"}


def index_of(seq: list, obj: object) -> int:
    """By identity: two duplicated rows are equal but not the same row."""
    return next(i for i, x in enumerate(seq) if x is obj)


def is_pexels(row: dict[str, str]) -> bool:
    return row["site"].lower() == "pexels" or "pexels.com" in row["url"].lower()


def fill_pexels(row: dict[str, str]) -> None:
    """Pexels photos: site, licence and cost follow from the URL."""
    if row["section"] == "asset" and is_pexels(row):
        row["site"] = row["site"] or "Pexels"
        row["license"] = row["license"] or PEXELS_LICENSE[0]
        row["license_url"] = row["license_url"] or PEXELS_LICENSE[1]
        row["cost"] = row["cost"] or "free"


def in_scope(row: dict[str, str], scope: str) -> bool:
    return scope == "all" or row["scope"] in (scope, "both", "")


def selected(rows: list[dict[str, str]], section: str, scope: str) -> list[dict[str, str]]:
    return [r for r in rows if r["section"] == section and r["include"] != "no"
            and in_scope(r, scope)]


def disclosure(rows: list[dict[str, str]], scope: str) -> tuple[list[str], list[str]]:
    """(categories whose AI output ships, categories where AI only helped)."""
    ai = [r for r in rows if r["section"] == "ai" and in_scope(r, scope)]
    ships = [k for k in AI_KINDS if any(r["kind"] == k and r["ai"] == "ships" for r in ai)]
    process = [k for k in AI_KINDS if k not in ships
               and any(r["kind"] == k and r["ai"] != "ships" for r in ai)]
    return ships, process


def check(rows: list[dict[str, str]], scope: str = "all") -> list[str]:
    problems = []
    for i, r in enumerate(rows, start=2):           # line 1 is the header
        where = f"line {i} ({r['section']} {r['name'] or r['my_name'] or '?'})"
        if r["section"] not in SECTIONS:
            problems.append(f"{where}: unknown section {r['section']!r}")
            continue
        if r["scope"] and r["scope"] not in SCOPES:
            problems.append(f"{where}: scope must be one of {', '.join(SCOPES)}")
        if r["include"] == "no" or not in_scope(r, scope):
            continue
        if any(PLACEHOLDER in v for v in r.values()):
            problems.append(f"{where}: still has a {PLACEHOLDER} to fill")
        s = r["section"]
        if s == "asset":
            if not r["by"]:
                problems.append(f"{where}: who made it?")
            if not r["url"]:
                problems.append(f"{where}: no source link")
            if not r["license"] and not is_pexels(r):
                problems.append(f"{where}: no licence or terms")
        elif s in ("tool", "framework") and not r["name"]:
            problems.append(f"{where}: no name")
        elif s == "ai":
            if r["kind"] not in AI_KINDS:
                problems.append(f"{where}: category must be one of {', '.join(AI_KINDS)}")
            if r["ai"] not in AI_USES:
                problems.append(f"{where}: 'output in the product?' must be ships or process")
            if not r["role"]:
                problems.append(f"{where}: say what it did")
        elif s == "terms" and not r["license"]:
            problems.append(f"{where}: no licence")
    if any(r["section"] == "tool" and r["ai"] == "yes" and r["include"] != "no"
           and in_scope(r, scope) for r in rows) and not any(
            r["section"] == "ai" and in_scope(r, scope) for r in rows):
        problems.append("a tool is marked generative AI but there is no AI row saying what it did")
    return problems


def itch_answer(rows: list[dict[str, str]], scope: str) -> str:
    ships, process = disclosure(rows, scope)
    if ships:
        cats = ", ".join(AI_KINDS[k] for k in ships)
        return f"itch.io 'Generative AI disclosure': Yes — tick {cats}."
    if process:
        cats = ", ".join(AI_KINDS[k] for k in process)
        return ("itch.io 'Generative AI disclosure': No AI output is recorded as shipping "
                f"(AI used in the process for {cats}). Make sure that is still true.")
    return "itch.io 'Generative AI disclosure': No (no AI rows in this scope)."


# ---------------------------------------------------------------- rendering

@dataclass(frozen=True)
class Link:
    text: str
    url: str


@dataclass(frozen=True)
class Strong:
    text: str


@dataclass(frozen=True)
class Em:
    text: str


Part = str | Link | Strong | Em


def _by(r: dict[str, str]) -> list[Part]:
    if not r["by"]:
        return []
    return [" by ", Link(r["by"], r["by_url"]) if r["by_url"] else r["by"]]


def _asset(r: dict[str, str]) -> list[Part]:
    label = r["my_name"] or r["name"] or "Untitled"
    parts: list[Part] = [Strong(label), ": "]
    if r["name"] and r["my_name"]:
        parts += [f"“{r['name']}”, "]
    parts += [r["kind"] or "work"]
    if is_pexels(r):
        # The form Pexels asks for: "Photo by X on Pexels", linked.
        parts += _by(r) + [" on ", Link("Pexels", r["url"])]
    else:
        parts += _by(r)
        if r["url"]:
            parts += [" — ", Link(r["site"] or "source", r["url"])]
    if r["license"]:
        lic: Part = Link(r["license"], r["license_url"]) if r["license_url"] else r["license"]
        parts += [" · ", lic]
    if r["cost"] and r["cost"] != "free":
        parts += [f" ({r['cost']})"]
    return parts


def _tool(r: dict[str, str]) -> list[Part]:
    name: Part = Link(r["name"], r["url"]) if r["url"] else r["name"]
    parts: list[Part] = [Strong(r["name"]) if not r["url"] else name] + _by(r)
    if r["role"]:
        parts += [" — ", r["role"]]
    return parts


def _framework(r: dict[str, str]) -> list[Part]:
    parts = _tool(r)
    if r["thanks"]:
        parts += [" — ", Em(r["thanks"])]
    return parts


def _ai(r: dict[str, str]) -> list[Part]:
    parts: list[Part] = [Strong(f"{AI_KINDS.get(r['kind'], r['kind']).capitalize()}"), ": "]
    parts += [r["role"]]
    if r["name"]:
        tool: Part = Link(r["name"], r["url"]) if r["url"] else r["name"]
        parts += [" (", tool]
        parts += [f", {r['by']})" if r["by"] else ")"]
    if r["ai"] == "process":
        parts += [" ", Em("Nothing it produced is in the release.")]
    return parts


def _terms(r: dict[str, str]) -> list[Part]:
    lic: Part = Link(r["license"], r["license_url"]) if r["license_url"] else r["license"]
    parts: list[Part] = [Strong(r["name"] or r["kind"] or "Everything"), ": "]
    if r["by"]:
        parts += [f"© {r['by']}. "]
    parts += [lic]
    if r["notes"]:
        parts += [". ", r["notes"]]
    return parts


def build(rows: list[dict[str, str]], scope: str) -> tuple[str, list[tuple[str, list]]]:
    """(title, [(heading, [paragraph or bullet list])]).  A block is either a
    list of parts (a paragraph) or a list of lists of parts (bullets)."""
    m = meta(rows)
    title = m.get("title") or "Credits"
    sections: list[tuple[str, list]] = []

    made: list = []
    if m.get("intro"):
        made.append([m["intro"]])
    if m.get("author"):
        who: Part = Link(m["author"], m["author_url"]) if m.get("author_url") else m["author"]
        made.append(["Made by ", who, f", {m['year']}." if m.get("year") else "."])
    if made:
        sections.append(("", made))

    for section, render in (("asset", _asset), ("framework", _framework), ("tool", _tool)):
        items = [render(r) for r in selected(rows, section, scope)]
        if items:
            sections.append((SECTION_TITLES[section], [items]))

    ai_rows = selected(rows, "ai", scope)
    ships, process = disclosure(rows, scope)
    if ships or process or m.get("ai_note"):
        blocks: list = []
        what = "this release" if scope == "all" else ("the tools" if scope == "tools" else "the game")
        if ships:
            cats = ", ".join(AI_KINDS[k] for k in ships)
            blocks.append([f"Generative AI output is part of {what}: {cats}."])
        elif process:
            cats = ", ".join(AI_KINDS[k] for k in process)
            blocks.append([f"No generative-AI output is part of {what}. AI was used along "
                           + f"the way for: {cats}."])
        if m.get("ai_note"):
            blocks.append([m["ai_note"]])
        if ai_rows:
            blocks.append([_ai(r) for r in ai_rows])
        sections.append((SECTION_TITLES["ai"], blocks))

    terms = [_terms(r) for r in selected(rows, "terms", scope)]
    if terms:
        tail = ["Third-party work credited above stays under its own licence."]
        if selected(rows, "asset", scope):
            sections.append((SECTION_TITLES["terms"], [terms, tail]))
        else:
            sections.append((SECTION_TITLES["terms"], [terms]))

    if m.get("disclaimer"):
        sections.append(("", [[Em(m["disclaimer"])]]))
    return title, sections


def _is_bullets(block: list) -> bool:
    return bool(block) and isinstance(block[0], list)


def _md_inline(parts: list[Part]) -> str:
    out = []
    for p in parts:
        if isinstance(p, Link):
            out.append(f"[{p.text}]({p.url})")
        elif isinstance(p, Strong):
            out.append(f"**{p.text}**")
        elif isinstance(p, Em):
            out.append(f"*{p.text}*")
        else:
            out.append(p)
    return "".join(out)


def _txt_inline(parts: list[Part]) -> str:
    out = []
    for p in parts:
        if isinstance(p, Link):
            out.append(p.text if p.url == p.text else f"{p.text} <{p.url}>")
        else:
            out.append(p if isinstance(p, str) else p.text)
    return "".join(out)


def _html_inline(parts: list[Part]) -> str:
    out = []
    for p in parts:
        if isinstance(p, Link):
            out.append(f'<a href="{html.escape(p.url)}">{html.escape(p.text)}</a>')
        elif isinstance(p, Strong):
            out.append(f"<strong>{html.escape(p.text)}</strong>")
        elif isinstance(p, Em):
            out.append(f"<em>{html.escape(p.text)}</em>")
        else:
            out.append(html.escape(p))
    return "".join(out)


def render(rows: list[dict[str, str]], scope: str = "game", fmt: str = "md") -> str:
    title, sections = build(rows, scope)
    lines: list[str] = []
    if fmt == "md":
        lines += [f"# {title} — credits", ""]
        for heading, blocks in sections:
            if heading:
                lines += [f"## {heading}", ""]
            for block in blocks:
                if _is_bullets(block):
                    lines += [f"- {_md_inline(b)}" for b in block]
                else:
                    lines.append(_md_inline(block))
                lines.append("")
    elif fmt == "txt":
        lines += [f"{title} — credits", "=" * len(f"{title} — credits"), ""]
        for heading, blocks in sections:
            if heading:
                lines += [heading.upper(), ""]
            for block in blocks:
                if _is_bullets(block):
                    lines += [f"  * {_txt_inline(b)}" for b in block]
                else:
                    lines.append(_txt_inline(block))
                lines.append("")
    elif fmt == "html":
        # A fragment, not a page: paste it into an itch.io description or
        # wrap it in your own template.
        lines.append(f"<h2>{html.escape(title)} — credits</h2>")
        for heading, blocks in sections:
            if heading:
                lines.append(f"<h3>{html.escape(heading)}</h3>")
            for block in blocks:
                if _is_bullets(block):
                    lines.append("<ul>")
                    lines += [f"  <li>{_html_inline(b)}</li>" for b in block]
                    lines.append("</ul>")
                else:
                    lines.append(f"<p>{_html_inline(block)}</p>")
    else:
        raise ValueError(f"format must be one of {', '.join(FORMATS)}")
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip() + "\n"


# ---------------------------------------------------------------- GUI

def gui(path: Path) -> None:
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk

    rows = load(path) if path.exists() else template()
    for r in rows:
        fill_pexels(r)
    state = {"dirty": False}

    root = tk.Tk()
    root.geometry("1100x760")

    def set_title() -> None:
        root.title(f"credits — {path.name}{' *' if state['dirty'] else ''}")

    def touch() -> None:
        state["dirty"] = True
        set_title()

    book = ttk.Notebook(root)
    book.pack(fill="both", expand=True)

    # -- Project tab: the meta rows as a fixed form
    proj = ttk.Frame(book, padding=10)
    book.add(proj, text="Project")
    meta_rows = {r["name"]: r for r in rows if r["section"] == "meta"}
    for key in META_KEYS:
        if key not in meta_rows:
            meta_rows[key] = blank_row("meta", scope="both", name=key)
            rows.insert(0, meta_rows[key])
    proj.columnconfigure(1, weight=1)
    for i, (key, label) in enumerate(META_KEYS.items()):
        ttk.Label(proj, text=label).grid(row=i, column=0, sticky="nw", padx=(0, 8), pady=3)
        long = key in ("intro", "ai_note", "disclaimer")
        if long:
            w = tk.Text(proj, height=4, wrap="word", undo=True)
            w.insert("1.0", meta_rows[key]["notes"])

            def on_text(_e: object, w: tk.Text = w, r: dict = meta_rows[key]) -> None:
                r["notes"] = w.get("1.0", "end-1c")
                touch()
            w.bind("<KeyRelease>", on_text)
        else:
            var = tk.StringVar(value=meta_rows[key]["notes"])

            def on_var(*_a: object, v: tk.StringVar = var, r: dict = meta_rows[key]) -> None:
                r["notes"] = v.get()
                touch()
            var.trace_add("write", on_var)
            w = ttk.Entry(proj, textvariable=var)
        w.grid(row=i, column=1, sticky="ew", pady=3)

    # -- one list + form tab per section
    def section_tab(section: str) -> None:
        frame = ttk.Frame(book, padding=6)
        book.add(frame, text=TAB_NAMES[section])
        frame.columnconfigure(0, weight=1)
        frame.rowconfigure(0, weight=1)
        cols = ("include", "scope", "kind", "label", "by")
        tree = ttk.Treeview(frame, columns=cols, show="headings", height=10, selectmode="browse")
        for c, wdt in zip(cols, (60, 60, 120, 380, 220)):
            tree.heading(c, text=c)
            tree.column(c, width=wdt, stretch=c == "label")
        tree.grid(row=0, column=0, sticky="nsew")
        bar = ttk.Frame(frame)
        bar.grid(row=1, column=0, sticky="w", pady=4)
        form = ttk.Frame(frame)
        form.grid(row=2, column=0, sticky="nsew")
        form.columnconfigure(1, weight=1)
        form.columnconfigure(3, weight=1)
        current: dict = {"row": None}
        widgets: dict[str, object] = {}

        def mine() -> list[dict[str, str]]:
            return [r for r in rows if r["section"] == section]

        def values(r: dict[str, str]) -> tuple[str, ...]:
            label = r["my_name"] or r["name"] or r["role"][:60]
            return r["include"], r["scope"], r["kind"], label, r["by"]

        def refill() -> None:
            sel = current["row"]
            tree.delete(*tree.get_children())
            for i, r in enumerate(mine()):
                tree.insert("", "end", iid=str(i), values=values(r))
            if any(r is sel for r in mine()):
                tree.selection_set(str(index_of(mine(), sel)))

        loading = {"on": False}

        def show(r: dict | None) -> None:
            current["row"] = r
            loading["on"] = True
            for f in FIELDS[section]:
                w = widgets[f.key]
                value = r[f.key] if r else ""
                if isinstance(w, tk.Text):
                    w.delete("1.0", "end")
                    w.insert("1.0", value)
                else:
                    w.set(value)
            loading["on"] = False

        def changed(key: str, value: str) -> None:
            r = current["row"]
            if loading["on"] or r is None or r[key] == value:
                return
            r[key] = value
            if key in ("url", "site") and section == "asset":
                before = dict(r)
                fill_pexels(r)
                loading["on"] = True
                for k in ("site", "license", "license_url", "cost"):
                    if r[k] != before[k]:
                        widgets[k].set(r[k])
                loading["on"] = False
            touch()
            # Update the list row in place: rebuilding it would reselect and
            # reload the form under the cursor.
            tree.item(str(index_of(mine(), r)), values=values(r))

        # One-line fields in two columns, then the multi-line ones full width.
        short = [f for f in FIELDS[section] if not f.multiline]
        half = (len(short) + 1) // 2
        places = [(f, i % half, 0 if i < half else 2) for i, f in enumerate(short)]
        places += [(f, half + i, 0) for i, f in enumerate(x for x in FIELDS[section]
                                                           if x.multiline)]
        for f, row_i, col in places:
            ttk.Label(form, text=f.label).grid(row=row_i, column=col, sticky="nw",
                                               padx=(8, 6), pady=2)
            if f.multiline:
                w = tk.Text(form, height=3, wrap="word", undo=True)
                w.bind("<KeyRelease>", lambda _e, k=f.key, w=w: changed(k, w.get("1.0", "end-1c")))
                w.grid(row=row_i, column=1, columnspan=3, sticky="ew", pady=2)
                widgets[f.key] = w
            else:
                var = tk.StringVar()
                var.trace_add("write", lambda *_a, k=f.key, v=var: changed(k, v.get()))
                box = ttk.Combobox(form, textvariable=var, values=f.choices)
                box.grid(row=row_i, column=col + 1, sticky="ew", pady=2)
                widgets[f.key] = var

        def pick(_e: object = None) -> None:
            s = tree.selection()
            r = mine()[int(s[0])] if s else None
            if r is not current["row"]:
                show(r)
        tree.bind("<<TreeviewSelect>>", pick)

        def add(copy: bool = False) -> None:
            base = current["row"]
            r = dict(base) if copy and base else blank_row(section)
            at = index_of(rows, base) + 1 if any(x is base for x in rows) else len(rows)
            rows.insert(at, r)
            current["row"] = r
            touch()
            refill()
            show(r)

        def delete() -> None:
            r = current["row"]
            if r is None:
                return
            del rows[index_of(rows, r)]
            current["row"] = None
            touch()
            refill()
            show(None)

        def move(step: int) -> None:
            r = current["row"]
            same = mine()
            if r is None:
                return
            j = index_of(same, r) + step
            if not 0 <= j < len(same):
                return
            a, b = index_of(rows, r), index_of(rows, same[j])
            rows[a], rows[b] = rows[b], rows[a]
            touch()
            refill()

        for text, cmd in (("New", add), ("Duplicate", lambda: add(True)), ("Delete", delete),
                          ("Up", lambda: move(-1)), ("Down", lambda: move(1))):
            ttk.Button(bar, text=text, command=cmd).pack(side="left", padx=(0, 4))
        refill()

    for s in ("asset", "tool", "framework", "ai", "terms"):
        section_tab(s)

    # -- Preview tab
    pv = ttk.Frame(book, padding=6)
    book.add(pv, text="Preview")
    pv.columnconfigure(0, weight=1)
    pv.rowconfigure(1, weight=1)
    top = ttk.Frame(pv)
    top.grid(row=0, column=0, sticky="ew")
    scope_var = tk.StringVar(value="game")
    fmt_var = tk.StringVar(value="md")
    ttk.Label(top, text="Scope").pack(side="left")
    ttk.Combobox(top, textvariable=scope_var, values=RENDER_SCOPES, width=8,
                 state="readonly").pack(side="left", padx=4)
    ttk.Label(top, text="Format").pack(side="left")
    ttk.Combobox(top, textvariable=fmt_var, values=FORMATS, width=6,
                 state="readonly").pack(side="left", padx=4)
    out = tk.Text(pv, wrap="word")
    out.grid(row=1, column=0, sticky="nsew")
    notes = tk.Text(pv, height=7, wrap="word", background="#f6f3e8")
    notes.grid(row=2, column=0, sticky="ew", pady=(6, 0))

    def preview(*_a: object) -> None:
        out.delete("1.0", "end")
        out.insert("1.0", render(rows, scope_var.get(), fmt_var.get()))
        problems = check(rows, scope_var.get())
        notes.delete("1.0", "end")
        notes.insert("1.0", itch_answer(rows, scope_var.get()) + "\n\n"
                     + ("\n".join(problems) if problems else "No problems found."))
    scope_var.trace_add("write", preview)
    fmt_var.trace_add("write", preview)
    book.bind("<<NotebookTabChanged>>", lambda _e: preview()
              if book.index("current") == book.index("end") - 1 else None)

    def copy() -> None:
        root.clipboard_clear()
        root.clipboard_append(out.get("1.0", "end-1c"))

    def export() -> None:
        name = filedialog.asksaveasfilename(
            defaultextension="." + fmt_var.get(), initialfile=f"CREDITS.{fmt_var.get()}",
            initialdir=path.parent)
        if name:
            Path(name).write_text(out.get("1.0", "end-1c"), encoding="utf-8")

    ttk.Button(top, text="Copy", command=copy).pack(side="left", padx=(12, 4))
    ttk.Button(top, text="Save as…", command=export).pack(side="left")

    def do_save(_e: object = None) -> None:
        save(path, rows)
        state["dirty"] = False
        set_title()

    bottom = ttk.Frame(root, padding=4)
    bottom.pack(fill="x")
    ttk.Button(bottom, text="Save CSV (Ctrl+S)", command=do_save).pack(side="left")
    ttk.Label(bottom, text=str(path.resolve())).pack(side="left", padx=8)
    root.bind("<Control-s>", do_save)

    def on_close() -> None:
        if state["dirty"]:
            answer = messagebox.askyesnocancel("credits", "Save changes before closing?")
            if answer is None:
                return
            if answer:
                do_save()
        root.destroy()
    root.protocol("WM_DELETE_WINDOW", on_close)
    set_title()
    root.mainloop()


# ---------------------------------------------------------------- CLI

def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("gui", help="edit the CSV and preview the credits")
    g.add_argument("csv", nargs="?", default="credits.csv", type=Path)
    r = sub.add_parser("render", help="print or write the credits")
    r.add_argument("csv", type=Path)
    r.add_argument("--scope", choices=RENDER_SCOPES, default="game")
    r.add_argument("--format", choices=FORMATS, default="md")
    r.add_argument("-o", "--out", type=Path)
    c = sub.add_parser("check", help="missing fields, unfilled ___, and the itch.io AI answer")
    c.add_argument("csv", type=Path)
    c.add_argument("--scope", choices=RENDER_SCOPES, default="all")
    i = sub.add_parser("init", help="write a blank CSV with the project rows")
    i.add_argument("csv", type=Path)
    a = p.parse_args(argv)

    if a.cmd == "gui":
        gui(a.csv)
        return 0
    if a.cmd == "init":
        if a.csv.exists():
            print(f"{a.csv} already exists", file=sys.stderr)
            return 1
        save(a.csv, template())
        print(f"wrote {a.csv}")
        return 0
    rows = load(a.csv)
    for row in rows:
        fill_pexels(row)
    if a.cmd == "render":
        text = render(rows, a.scope, a.format)
        if a.out:
            a.out.write_text(text, encoding="utf-8")
            print(f"wrote {a.out}")
        else:
            sys.stdout.reconfigure(encoding="utf-8")
            sys.stdout.write(text)
        return 0
    problems = check(rows, a.scope)
    for scope in (["game", "tools"] if a.scope == "all" else [a.scope]):
        print(f"[{scope}] {itch_answer(rows, scope)}")
    for line in problems:
        print(line)
    print(f"{len(problems)} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
