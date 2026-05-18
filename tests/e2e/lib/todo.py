"""Auto-Update von `TODO.md` nach einem fehlgeschlagenen E2E-Run.

Bedingung: `errors.md` existiert (= mindestens ein Szenario gefailt).
Verhalten: Fügt einen kompakten Eintrag unter `## Hohe Priorität` ein,
mit Link auf den Run-Report. Falls für denselben Run-Timestamp bereits
ein Eintrag existiert (z. B. weil der Test versehentlich erneut lief
und idempotent neu schreiben würde), wird nichts gemacht.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Optional


HIGH_PRIORITY_HEADER = "## Hohe Priorität"


def append_e2e_failure_entry(
    todo_path: Path,
    run_id: str,
    report_path: Path,
    errors_path: Path,
    failed_count: int,
    repo_root: Path,
) -> Optional[str]:
    """Hängt einen neuen Eintrag oben unter `## Hohe Priorität` ein. Gibt
    die hinzugefügte Markdown-Zeile zurück, oder None wenn nichts geschah
    (z. B. weil schon ein Eintrag mit dem Run-ID existiert).
    """
    todo_path = Path(todo_path)
    if not todo_path.exists():
        return None

    content = todo_path.read_text(encoding="utf-8")
    if run_id in content:
        return None

    # Pfade relativ zum repo_root machen — der TODO-Eintrag soll im
    # Browser/Editor klickbar sein.
    try:
        rel_report = report_path.resolve().relative_to(repo_root.resolve())
        rel_errors = errors_path.resolve().relative_to(repo_root.resolve())
    except ValueError:
        rel_report = report_path
        rel_errors = errors_path

    rel_report_str = str(rel_report).replace("\\", "/")
    rel_errors_str = str(rel_errors).replace("\\", "/")

    today = time.strftime("%Y-%m-%d %H:%M")
    new_lines = [
        f"- **E2E-Run {today}: {failed_count} Fehler** — Details in",
        f"  [`{rel_errors_str}`]({rel_errors_str}). Run-Report:",
        f"  [`{rel_report_str}`]({rel_report_str}).",
    ]
    new_block = "\n".join(new_lines)

    if HIGH_PRIORITY_HEADER not in content:
        # Fallback: Eintrag ganz oben anhängen, mit Sektions-Header
        prefix = f"# TODO\n\n{HIGH_PRIORITY_HEADER}\n\n{new_block}\n\n"
        if content.startswith("# TODO"):
            # Skip existing top header line + leerzeile
            lines = content.split("\n", 2)
            rest = lines[2] if len(lines) > 2 else ""
            content = f"# TODO\n\n{HIGH_PRIORITY_HEADER}\n\n{new_block}\n\n{rest}"
        else:
            content = prefix + content
    else:
        # Direkt unter den `## Hohe Priorität`-Header einfügen, vor dem
        # ersten existierenden Item.
        marker = HIGH_PRIORITY_HEADER + "\n"
        idx = content.find(marker)
        insert_at = idx + len(marker)
        # Erste Folge-Leerzeile überspringen, damit unsere drei Zeilen direkt
        # an die existierende Liste stoßen.
        if content[insert_at:insert_at + 1] == "\n":
            insert_at += 1
        content = content[:insert_at] + new_block + "\n\n" + content[insert_at:]

    todo_path.write_text(content, encoding="utf-8")
    return new_block
