"""API-level test for POST /search (Vault-Volltextsuche, Etappe S1).

Deckt den synchronen Automation-Endpunkt und damit den Suchkern
(commands/search.rs + search.rs) ab: Treffer + Zeilen/Spalten (UTF-16),
Ordner- vs. Vault-Scope (Scope via Pin des Fixture-Ordners), caseSensitive,
wholeWord, per-Datei-Truncation, QueryTooShort-Fehler und gitignore-Skip.
Zusätzlich includeHidden: eigenes Fake-Repo (`.git` + `.gitignore`) mit
`.hidden.md`, Datei unter hidden Dir und gitignorierter Datei — ohne Flag
übersprungen, mit Flag gefunden (kein Screenshot, kein fixtures/-Pfad).
Dateilisten-Scope `files` (R10): genau die übergebenen Dateien, leere Liste,
relative Pfade, Konflikt mit scope und mehr als 500 Einträge. Ein Alt-Feld
`openTabs` (Scope entfernt in S9) wird wie jedes unbekannte Feld ignoriert (F12).

Kein Screenshot-Vergleich (reines API-Szenario). Die Fixtures liegen in einem
System-Temp-Ordner (auto-cleanup); der einzige persistente Seiteneffekt ist
der Verzeichnis-Pin, der im finally wieder entfernt wird.
"""

import os
import shutil
import sys
import tempfile

from lib.api import ApiError


def _write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def _write_bytes(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def _by_name(resp, name):
    for f in resp.get("files") or []:
        if f["fileName"] == name:
            return f
    return None


def run(ctx):
    with tempfile.TemporaryDirectory() as td:
        # Git-Repo, damit .gitignore geehrt wird (require_git-Default).
        _write(os.path.join(td, ".git", "HEAD"), "ref: refs/heads/main\n")
        _write(os.path.join(td, ".gitignore"), "ignored.md\n")

        _write(
            os.path.join(td, "alpha.md"),
            "# Alpha\nxy needle here\nNeedle up top\nanother needle line\n",
        )
        _write(os.path.join(td, "beta.txt"), "plain needle in text\n")
        _write(os.path.join(td, "sub", "gamma.md"), "gamma has a needle too\n")

        # Übersprungen: gitignored + hidden.
        _write(os.path.join(td, "ignored.md"), "needle should be skipped\n")
        _write(os.path.join(td, ".hidden.md"), "needle hidden skip\n")

        # Eigener Ordner für wholeWord-Isolation.
        _write(
            os.path.join(td, "wwdir", "ww.md"),
            "needless chore\na needle here\n",
        )
        # Eigener Ordner für per-Datei-Truncation (>50 Treffer-Zeilen).
        big = "".join(f"line {i} match\n" for i in range(60))
        _write(os.path.join(td, "bigdir", "big.md"), big)

        # Eigener Ordner für UTF-16-Spalten: Umlaut + ß + Emoji (Surrogatpaar)
        # vor dem Treffer. Eigener Scope + eigener Suchbegriff, damit die
        # Vault-weite "needle"-Liste unberührt bleibt.
        _write(os.path.join(td, "u16dir", "utf16.md"), "äß😀 TREFFER da\n")

        # Eigener Ordner für globale Truncation: 12×60 Treffer-Zeilen → nach
        # per-Datei-Cap 12×50 = 600 > 500 globaler Deckel.
        for f in range(12):
            _write(
                os.path.join(td, "capdir", f"cap_{f:02}.md"),
                "".join("cap here\n" for _ in range(60)),
            )

        # S4-Dateityp-Filter (eigener Suchbegriff "zzcustom", damit die
        # "needle"-Vault-Liste unberührt bleibt). `.foobar` liegt außerhalb
        # TEXT_EXT → nur der Custom-Filter nimmt es; die NUL-Variante bleibt
        # auch unter Custom geskippt.
        _write(os.path.join(td, "ff", "note.md"), "zzcustom in md\n")
        _write(os.path.join(td, "ff", "data.txt"), "zzcustom in txt\n")
        _write(os.path.join(td, "ff", "weird.foobar"), "zzcustom in foobar\n")
        _write_bytes(
            os.path.join(td, "ff", "bin.foobar"), b"pre \x00\x00 zzcustom here\n"
        )

        pinned = False
        try:
            with ctx.step("pin fixture dir as vault root"):
                ctx.api.workspace_pin(td, is_directory=True)
                pinned = True

            with ctx.step("vault search 'needle' finds md/txt, skips gitignored/hidden"):
                resp = ctx.api.search("needle")
                found = sorted(f["fileName"] for f in resp.get("files") or [])
                # ww.md (wwdir) enthält "needless" + "needle" → gehört dazu;
                # big.md hat nur "match"; ignored.md/.hidden.md sind gefiltert.
                ctx.expect(
                    found == ["alpha.md", "beta.txt", "gamma.md", "ww.md"],
                    f"unexpected files: {found}",
                )
                ctx.expect(
                    _by_name(resp, "ignored.md") is None,
                    "gitignored file must be skipped",
                )
                ctx.expect(
                    _by_name(resp, ".hidden.md") is None,
                    "hidden file must be skipped",
                )
                stats = resp.get("stats") or {}
                ctx.expect(
                    stats.get("filesMatched") == 4,
                    f"filesMatched={stats.get('filesMatched')}",
                )
                ctx.expect(stats.get("truncated") is False, f"stats={stats}")

            with ctx.step("hit line/col are 1-based UTF-16 coordinates"):
                resp = ctx.api.search("needle")
                alpha = _by_name(resp, "alpha.md")
                ctx.expect(alpha is not None, "alpha.md missing")
                # "xy needle here" auf Zeile 2 → "xy " = 3 Units davor → col 4.
                first = alpha["hits"][0]
                ctx.expect(first["line"] == 2, f"line={first['line']}")
                ctx.expect(first["colUtf16"] == 4, f"colUtf16={first['colUtf16']}")
                ctx.expect(first["lenUtf16"] == 6, f"lenUtf16={first['lenUtf16']}")
                ctx.expect(
                    first["ranges"] == [[3, 6]],
                    f"ranges={first['ranges']}",
                )

            with ctx.step("folder scope restricts to that directory"):
                resp = ctx.api.search("needle", scope=os.path.join(td, "sub"))
                found = sorted(f["fileName"] for f in resp.get("files") or [])
                ctx.expect(found == ["gamma.md"], f"folder scope files: {found}")

            with ctx.step("caseSensitive distinguishes Needle from needle"):
                ci = ctx.api.search("Needle", case_sensitive=False)
                cs = ctx.api.search("Needle", case_sensitive=True)
                alpha_ci = _by_name(ci, "alpha.md")
                alpha_cs = _by_name(cs, "alpha.md")
                # case-insensitive: Zeilen 2,3,4 treffen (needle/Needle/needle).
                ctx.expect(len(alpha_ci["hits"]) == 3, f"ci hits={len(alpha_ci['hits'])}")
                # case-sensitive: nur Zeile 3 "Needle up top".
                ctx.expect(len(alpha_cs["hits"]) == 1, f"cs hits={len(alpha_cs['hits'])}")
                ctx.expect(alpha_cs["hits"][0]["line"] == 3, f"cs line={alpha_cs['hits'][0]['line']}")

            with ctx.step("wholeWord excludes substring matches"):
                scope = os.path.join(td, "wwdir")
                loose = ctx.api.search("needle", scope=scope, whole_word=False)
                strict = ctx.api.search("needle", scope=scope, whole_word=True)
                ww = _by_name(loose, "ww.md")
                ww_strict = _by_name(strict, "ww.md")
                # loose: "needless" (Zeile 1) + "needle" (Zeile 2) = 2 Hits.
                ctx.expect(len(ww["hits"]) == 2, f"loose hits={len(ww['hits'])}")
                # strict: nur das ganze Wort "needle" (Zeile 2).
                ctx.expect(len(ww_strict["hits"]) == 1, f"strict hits={len(ww_strict['hits'])}")
                ctx.expect(ww_strict["hits"][0]["line"] == 2, "strict must hit line 2")

            with ctx.step("per-file truncation caps at 50 hits"):
                resp = ctx.api.search("match", scope=os.path.join(td, "bigdir"))
                bigf = _by_name(resp, "big.md")
                ctx.expect(bigf is not None, "big.md missing")
                ctx.expect(len(bigf["hits"]) == 50, f"hits={len(bigf['hits'])}")
                ctx.expect(bigf["truncated"] is True, "file must be flagged truncated")

            with ctx.step("UTF-16 columns survive umlaut+emoji over JSON route"):
                # "äß😀 TREFFER da": ä(1)+ß(1)+😀(2)+Space(1) = 5 Units vor dem
                # Treffer. Eine byte-basierte Serialisierung würde hier auffliegen.
                resp = ctx.api.search("TREFFER", scope=os.path.join(td, "u16dir"))
                uf = _by_name(resp, "utf16.md")
                ctx.expect(uf is not None, "utf16.md missing")
                hit = uf["hits"][0]
                ctx.expect(hit["colUtf16"] == 6, f"colUtf16={hit['colUtf16']}")
                ctx.expect(hit["lenUtf16"] == 7, f"lenUtf16={hit['lenUtf16']}")
                ctx.expect(hit["snippetOffsetUtf16"] == 0, f"off={hit['snippetOffsetUtf16']}")
                ctx.expect(hit["ranges"] == [[5, 7]], f"ranges={hit['ranges']}")

            with ctx.step("global truncation flags stats.truncated"):
                resp = ctx.api.search("cap", scope=os.path.join(td, "capdir"))
                stats = resp.get("stats") or {}
                ctx.expect(stats.get("truncated") is True, f"stats={stats}")
                ctx.expect(stats.get("hits", 9999) <= 500, f"hits={stats.get('hits')}")

            with ctx.step("query shorter than 2 chars → 400"):
                try:
                    ctx.api.search("n")
                    ctx.expect(False, "too-short query accepted")
                except ApiError as err:
                    ctx.expect(400 <= err.status < 500, f"status={err.status}")

            # --- S4: Regex-Modus -------------------------------------------

            with ctx.step("regex mode matches pattern"):
                resp = ctx.api.search(
                    "ne+dle", scope=os.path.join(td, "sub"), regex=True
                )
                # sub/gamma.md: "gamma has a needle too" → "ne+dle" trifft "needle".
                ctx.expect(
                    _by_name(resp, "gamma.md") is not None,
                    "regex pattern should match 'needle'",
                )

            with ctx.step("invalid regex → 400"):
                try:
                    ctx.api.search("(unclosed", regex=True)
                    ctx.expect(False, "invalid regex accepted")
                except ApiError as err:
                    ctx.expect(err.status == 400, f"status={err.status}")

            with ctx.step("regex + wholeWord → 400"):
                try:
                    ctx.api.search("needle", regex=True, whole_word=True)
                    ctx.expect(False, "regex+wholeWord accepted")
                except ApiError as err:
                    ctx.expect(err.status == 400, f"status={err.status}")

            # --- S4: Dateityp-Filter ---------------------------------------

            with ctx.step("fileFilter markdown restricts to .md"):
                resp = ctx.api.search(
                    "zzcustom", scope=os.path.join(td, "ff"), file_filter="markdown"
                )
                found = sorted(f["fileName"] for f in resp.get("files") or [])
                ctx.expect(found == ["note.md"], f"markdown filter: {found}")

            with ctx.step("fileFilter allText covers .md + .txt, skips .foobar"):
                resp = ctx.api.search(
                    "zzcustom", scope=os.path.join(td, "ff"), file_filter="allText"
                )
                found = sorted(f["fileName"] for f in resp.get("files") or [])
                ctx.expect(found == ["data.txt", "note.md"], f"allText filter: {found}")

            with ctx.step("fileFilter custom matches .foobar, still skips NUL binary"):
                resp = ctx.api.search(
                    "zzcustom",
                    scope=os.path.join(td, "ff"),
                    file_filter="custom",
                    custom_extensions="foobar",
                )
                found = sorted(f["fileName"] for f in resp.get("files") or [])
                # weird.foobar trifft; bin.foobar (NUL) bleibt geskippt.
                ctx.expect(found == ["weird.foobar"], f"custom filter: {found}")

            with ctx.step("empty custom extension list → 400"):
                try:
                    ctx.api.search(
                        "zzcustom", file_filter="custom", custom_extensions="  "
                    )
                    ctx.expect(False, "empty custom list accepted")
                except ApiError as err:
                    ctx.expect(err.status == 400, f"status={err.status}")

            with ctx.step("unknown fileFilter → 400"):
                try:
                    ctx.api.search("zzcustom", file_filter="bogus")
                    ctx.expect(False, "unknown filter accepted")
                except ApiError as err:
                    ctx.expect(err.status == 400, f"status={err.status}")

            # --- S9: OpenTabs-Scope entfernt (F12) ---------------------------

            with ctx.step("F12: unbekanntes Feld openTabs wird ignoriert → Vault-Suche"):
                # Die Request-Structs haben kein deny_unknown_fields: ein
                # Alt-Aufrufer mit `openTabs` bekommt die normale Vault-Suche.
                resp = ctx.api._request(
                    "POST", "/search", {"query": "zzcustom", "openTabs": True}
                )
                ctx.expect(
                    _by_name(resp, "data.txt") is not None,
                    f"openTabs nicht ignoriert: {resp.get('files')}",
                )

            # --- includeHidden / includeIgnored: getrennte Opt-ins -----------
            # Referenz-Fixture: .gitignore = secret.md + .herd/; Dateien
            # visible.md, secret.md (ignoriert), .hidden.md, .herd/spec.md
            # (versteckt UND ignoriert) sowie eine .git/-Datei, die nie
            # auftauchen darf. Eigenes Temp-Verzeichnis (kein fixtures/).
            with ctx.step("includeHidden/includeIgnored matrix (hidden vs ignored)"):
                hidden_td = tempfile.mkdtemp(prefix="folio-e2e-search-hidden-")
                try:
                    _write(
                        os.path.join(hidden_td, ".git", "HEAD"),
                        "ref: refs/heads/main\n",
                    )
                    _write(
                        os.path.join(hidden_td, ".git", "hooks", "pre-commit.md"),
                        "hidtok in git dir\n",
                    )
                    _write(os.path.join(hidden_td, ".gitignore"), "secret.md\n.herd/\n")
                    _write(os.path.join(hidden_td, "visible.md"), "hidtok visible\n")
                    _write(os.path.join(hidden_td, "secret.md"), "hidtok secret\n")
                    _write(os.path.join(hidden_td, ".hidden.md"), "hidtok dotfile\n")
                    _write(
                        os.path.join(hidden_td, ".herd", "spec.md"),
                        "hidtok hidden dir\n",
                    )
                    ctx.api.workspace_pin(hidden_td, is_directory=True)
                    try:
                        def names(resp):
                            return sorted(f["fileName"] for f in resp.get("files") or [])

                        both_off = ctx.api.search("hidtok", scope=hidden_td)
                        ctx.expect(
                            names(both_off) == ["visible.md"],
                            f"both off: {names(both_off)}",
                        )
                        only_hidden = ctx.api.search(
                            "hidtok", scope=hidden_td, include_hidden=True,
                            include_ignored=False,
                        )
                        ctx.expect(
                            names(only_hidden) == [".hidden.md", "visible.md"],
                            f"only hidden: {names(only_hidden)}",
                        )
                        only_ignored = ctx.api.search(
                            "hidtok", scope=hidden_td, include_ignored=True
                        )
                        ctx.expect(
                            names(only_ignored) == ["secret.md", "visible.md"],
                            f"only ignored: {names(only_ignored)}",
                        )
                        both_on = ctx.api.search(
                            "hidtok", scope=hidden_td, include_hidden=True,
                            include_ignored=True,
                        )
                        ctx.expect(
                            names(both_on)
                            == [".hidden.md", "secret.md", "spec.md", "visible.md"],
                            f"both on: {names(both_on)}",
                        )
                        # Kompatibilität: ohne includeIgnored gilt includeHidden
                        # (alter Vertrag: ein Flag für beides).
                        compat = ctx.api.search(
                            "hidtok", scope=hidden_td, include_hidden=True
                        )
                        ctx.expect(
                            names(compat)
                            == [".hidden.md", "secret.md", "spec.md", "visible.md"],
                            f"compat includeHidden alone: {names(compat)}",
                        )
                        # .git/-Datei in keinem Fall.
                        for label, resp in (
                            ("both off", both_off),
                            ("only hidden", only_hidden),
                            ("only ignored", only_ignored),
                            ("both on", both_on),
                            ("compat", compat),
                        ):
                            ctx.expect(
                                all(
                                    ".git" not in (f.get("path") or "")
                                    for f in resp.get("files") or []
                                ),
                                f".git leaked into results ({label})",
                            )
                    finally:
                        ctx.api.workspace_unpin(hidden_td)
                finally:
                    shutil.rmtree(hidden_td, ignore_errors=True)

            # --- files: Dateilisten-Scope („Gefilterte Dateien“, R10) -------
            # Kein Pin nötig: die Liste ist der Scope. Fixture der vorgegebenen
            # Referenzfälle; die Wrapper-API kennt `files` nicht, daher roh.
            with ctx.step("files scope: exact list, empty list, boundary errors"):
                files_td = tempfile.mkdtemp(prefix="folio-e2e-search-files-")
                try:
                    r = files_td.replace("\\", "/")
                    for rel, text in (
                        ("notes/spec-a.md", "TODO alpha"),
                        ("notes/other.md", "TODO beta"),
                        (".herd/spec-b.md", "TODO gamma"),
                        ("deep/x/spec-c.txt", "TODO delta"),
                    ):
                        _write(os.path.join(files_td, *rel.split("/")), text)
                    other = f"{r}/notes/other.md"
                    spec_c = f"{r}/deep/x/spec-c.txt"

                    def files_search(files, **extra):
                        body = {
                            "query": "TODO",
                            "fileFilter": "allText",
                            "files": files,
                        }
                        body.update(extra)
                        return ctx.api._request("POST", "/search", body)

                    resp = files_search([other, spec_c])
                    got = sorted(f["path"] for f in resp.get("files") or [])
                    ctx.expect(got == sorted([other, spec_c]), f"files exact: {got}")
                    ctx.expect(
                        resp["stats"]["filesScanned"] == 2,
                        f"files scanned: {resp['stats']}",
                    )

                    empty = files_search([])
                    ctx.expect(
                        empty["stats"]["filesScanned"] == 0 and not empty.get("files"),
                        f"empty files: {empty}",
                    )

                    for label, files, extra in (
                        ("relative path", ["notes/other.md"], {}),
                        ("files + scope", [other], {"scope": r}),
                        (
                            "501 entries",
                            [f"{r}/f{i}.md" for i in range(501)],
                            {},
                        ),
                    ):
                        try:
                            files_search(files, **extra)
                            ctx.expect(False, f"{label} accepted")
                        except ApiError as err:
                            ctx.expect(err.status == 400, f"{label}: status={err.status}")
                finally:
                    shutil.rmtree(files_td, ignore_errors=True)

        finally:
            # Offene Tabs aufräumen, bevor der Fixture-Tempordner verschwindet.
            try:
                ctx.api.tabs_close_all()
            except Exception:
                pass
            if pinned:
                # Unpin-Fehler NICHT still schlucken — aber einen bereits
                # laufenden Original-Fehler nicht maskieren.
                had_error = sys.exc_info()[0] is not None
                try:
                    ctx.api.workspace_unpin(td)
                except Exception:
                    if not had_error:
                        raise
