"""E2E: Git-Status-Dots, Tab-Marker, Diff und Filter „nur geänderte".

Deckt die vier Git-Features plus ihre Wechselwirkungen im echten WebView
ab — inklusive Auto-Expand unter der Pin-Wurzel und die beiden
Kreuz-Review-Fallen (Präfix auf Segmentgrenze, Expand nur im Pin-Scope).

Das Repo liegt auf einem festen Temp-Pfad (sichtbar in Vault und
Statusleiste, daher Teil der Visual-Baseline) und wird im Szenario
angelegt und im finally wieder entfernt — kein .git unter fixtures/.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

REPO_DIR = Path(tempfile.gettempdir()) / "folio-e2e-gitrepo"
TEMPLATE_DIR = Path(tempfile.gettempdir()) / "folio-e2e-git-template"

# git status / git show haben backendseitig 10 s Deadline.
GIT_POLL_S = 15.0

HEAD_COMMITTED = "Original committed body."
WORK_COMMITTED = "Committed changed after HEAD."
HEAD_SECOND = "Original second body."
WORK_SECOND = "Second changed after HEAD."
UNCHANGED_BODY = "Unchanged stays committed."
UNTRACKED_BODY = "Never committed file."
KIND_BODY = "Child of untracked folder."
CLEAN_BODY = "Sibling prefix must stay clean."
AUSSEN_HEAD = "Outside pin original."
AUSSEN_WORK = "Outside pin changed after HEAD."
DIRTY_LINE = "DIRTY BUFFER LINE"
PNG_HEAD = b"\x89PNG\r\n\x1a\nHEAD"
PNG_WORK = b"\x89PNG\r\n\x1a\nWORK"


def _norm(path: str | Path) -> str:
    return str(path).replace("\\", "/")


def _evalv(ctx, js: str, timeout_ms: int = 5000):
    return ctx.api.eval(js, timeout_ms=timeout_ms).get("value")


def _poll(fn, timeout: float = 5.0, interval: float = 0.05):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    return last


def _git_env() -> dict[str, str]:
    env = os.environ.copy()
    env["GIT_CONFIG_GLOBAL"] = "/dev/null"
    env["GIT_CONFIG_SYSTEM"] = "/dev/null"
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    env["GIT_TEMPLATE_DIR"] = str(TEMPLATE_DIR)
    env["GIT_AUTHOR_NAME"] = "Folio E2E"
    env["GIT_AUTHOR_EMAIL"] = "folio-e2e@example.test"
    env["GIT_COMMITTER_NAME"] = "Folio E2E"
    env["GIT_COMMITTER_EMAIL"] = "folio-e2e@example.test"
    env.pop("GIT_DIR", None)
    env.pop("GIT_WORK_TREE", None)
    env.pop("GIT_INDEX_FILE", None)
    return env


def _git(repo: Path, *args: str) -> None:
    cmd = [
        "git",
        "-c",
        "user.name=Folio E2E",
        "-c",
        "user.email=folio-e2e@example.test",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.autocrlf=false",
        "-c",
        f"init.templateDir={TEMPLATE_DIR}",
        *args,
    ]
    subprocess.run(
        cmd,
        cwd=repo,
        check=True,
        env=_git_env(),
        capture_output=True,
        text=True,
    )


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def _write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def _setup_repo() -> Path:
    shutil.rmtree(REPO_DIR, ignore_errors=True)
    shutil.rmtree(TEMPLATE_DIR, ignore_errors=True)
    TEMPLATE_DIR.mkdir(parents=True)
    REPO_DIR.mkdir(parents=True)
    pinned = REPO_DIR / "pinned"
    _write(pinned / "committed.md", f"# committed\n\n{HEAD_COMMITTED}\n")
    _write(pinned / "second.md", f"# second\n\n{HEAD_SECOND}\n")
    _write(pinned / "unchanged.md", f"# unchanged\n\n{UNCHANGED_BODY}\n")
    _write(pinned / "neuer-ordnerlich" / "clean.md", f"# clean\n\n{CLEAN_BODY}\n")
    _write(REPO_DIR / "aussen" / "geaendert.md", f"# aussen\n\n{AUSSEN_HEAD}\n")
    _write_bytes(pinned / "icon.png", PNG_HEAD)
    _git(REPO_DIR, "init", "-b", "main")
    _git(REPO_DIR, "config", "--local", "core.excludesFile", "/dev/null")
    _git(REPO_DIR, "config", "--local", "core.autocrlf", "false")
    _git(
        REPO_DIR,
        "add",
        "pinned/committed.md",
        "pinned/second.md",
        "pinned/unchanged.md",
        "pinned/neuer-ordnerlich/clean.md",
        "pinned/icon.png",
        "aussen/geaendert.md",
    )
    _git(REPO_DIR, "commit", "-m", "initial")
    _write(
        pinned / "committed.md",
        f"# committed\n\n{HEAD_COMMITTED}\n{WORK_COMMITTED}\n",
    )
    _write(
        pinned / "second.md",
        f"# second\n\n{HEAD_SECOND}\n{WORK_SECOND}\n",
    )
    _write(
        REPO_DIR / "aussen" / "geaendert.md",
        f"# aussen\n\n{AUSSEN_HEAD}\n{AUSSEN_WORK}\n",
    )
    _write_bytes(pinned / "icon.png", PNG_WORK)
    _write(pinned / "neu.md", f"# neu\n\n{UNTRACKED_BODY}\n")
    _write(pinned / "neuer-ordner" / "kind.md", f"# kind\n\n{KIND_BODY}\n")
    return REPO_DIR


def _node_sel(path: str) -> str:
    # Nur die Pinned-Section: geoeffnete Dateien stehen zusaetzlich in
    # Recents, und querySelector wuerde nach collapse-all den Recent-Knoten
    # als falsch-positives "noch aufgeklappt" werten.
    return (
        f'#vault-tree li.section[data-section="pinned"] '
        f'li.node[data-path="{path}"]'
    )


def _node(ctx, path: str):
    sel = json.dumps(_node_sel(path))
    return _evalv(
        ctx,
        "(function(){"
        f"var n=document.querySelector({sel});"
        "if(!n)return null;"
        "return{"
        "className:n.className,"
        "title:n.getAttribute('title')||'',"
        "kind:n.getAttribute('data-kind'),"
        "dataText:n.getAttribute('data-text'),"
        "vfHidden:n.classList.contains('vf-hidden'),"
        "gitModified:n.classList.contains('git-modified'),"
        "gitUntracked:n.classList.contains('git-untracked')"
        "};})()",
    )


def _click_row(ctx, path: str) -> bool:
    sel = json.dumps(_node_sel(path) + " > .row")
    return _evalv(
        ctx,
        "(function(){"
        f"var n=document.querySelector({sel});"
        "if(!n)return false;"
        "n.dispatchEvent(new MouseEvent('click',{bubbles:true}));"
        "return true;})()",
    ) is True


def _click_id(ctx, el_id: str) -> None:
    ctx.api.eval(
        "document.getElementById(%s)"
        ".dispatchEvent(new MouseEvent('click',{bubbles:true}))" % json.dumps(el_id)
    )


def _set_filter_query(ctx, query: str) -> None:
    js = (
        "(function(){var el=document.getElementById('vault-filter-input');"
        "if(!el)return false;el.value=%s;"
        "el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()"
        % json.dumps(query)
    )
    ctx.expect(_evalv(ctx, js) is True, "Filter-Input nicht gesetzt")


def _file_visible(ctx, path: str) -> bool:
    info = _node(ctx, path)
    return bool(info) and info.get("kind") == "file" and not info.get("vfHidden")


def _dir_visible(ctx, path: str) -> bool:
    info = _node(ctx, path)
    return bool(info) and info.get("kind") == "dir" and not info.get("vfHidden")


def _file_hidden(ctx, path: str) -> bool:
    """True, wenn der Dateiknoten fehlt oder vf-hidden ist."""
    info = _node(ctx, path)
    if not info:
        return True
    return info.get("kind") == "file" and bool(info.get("vfHidden"))


def _cls_is(class_name: str, prefix: str) -> bool:
    return class_name == prefix or class_name.startswith(prefix + " ")


def _tab_dom(ctx, path: str):
    title = json.dumps(path)
    return _evalv(
        ctx,
        "(function(){"
        "var items=document.querySelectorAll('#tab-bar .tab-item[data-tab-id]');"
        f"var want={title};"
        "for(var i=0;i<items.length;i++){"
        "var el=items[i];"
        "if((el.getAttribute('title')||'')!==want)continue;"
        "var kids=[];"
        "for(var c=el.firstElementChild;c;c=c.nextElementSibling)kids.push(c.className);"
        "return{"
        "exists:true,"
        "id:el.getAttribute('data-tab-id'),"
        "className:el.className,"
        "gitModified:el.classList.contains('tab-git-modified'),"
        "active:el.classList.contains('active'),"
        "hasGitMark:!!el.querySelector(':scope > .tab-git'),"
        "hasDirty:!!el.querySelector(':scope > .tab-dirty'),"
        "childClasses:kids"
        "};}"
        "return null;})()",
    )


def _diff_state(ctx):
    return _evalv(
        ctx,
        """(() => {
            const modified = (window.FolioDiffView
                && typeof window.FolioDiffView.getModified === 'function')
                ? window.FolioDiffView.getModified() : '';
            let original = '';
            const monaco = window.monaco;
            if (monaco && monaco.editor && typeof monaco.editor.getDiffEditors === 'function') {
                const diffs = monaco.editor.getDiffEditors();
                for (let i = 0; i < diffs.length; i++) {
                    const model = diffs[i].getModel && diffs[i].getModel();
                    if (model && model.original && typeof model.original.getValue === 'function') {
                        original = model.original.getValue();
                        break;
                    }
                }
            }
            const region = document.getElementById('ai-diff-region');
            return {
                original,
                modified,
                open: document.body.classList.contains('git-diff-open'),
                regionHidden: !region || !!region.hidden,
                hint: (document.getElementById('ai-diff-hint') || {}).textContent || '',
                title: (document.getElementById('ai-diff-title') || {}).textContent || '',
                virtualActive: !!document.querySelector(
                    '#tab-bar .tab-item[data-tab-id="git-diff"].active'
                )
            };
        })()""",
    ) or {}


def _git_diff_open(ctx) -> bool:
    st = _diff_state(ctx)
    return st.get("open") is True and st.get("regionHidden") is False


def _close_git_diff(ctx) -> None:
    try:
        _evalv(
            ctx,
            "(function(){"
            "var btn=document.querySelector("
            "'#tab-bar .tab-item[data-tab-id=\"git-diff\"] .tab-close');"
            "if(btn){btn.click();return 'clicked';}"
            "document.dispatchEvent(new KeyboardEvent('keydown',"
            "{key:'Escape',bubbles:true}));"
            "return 'escape';})()",
        )
    except Exception:
        try:
            ctx.api.key("Escape")
        except Exception:
            pass
    _poll(lambda: not _git_diff_open(ctx), timeout=3.0)


def _close_context_menu(ctx) -> None:
    try:
        ctx.api.key("Escape")
    except Exception:
        pass
    _poll(
        lambda: "open"
        not in ((ctx.api.dom("#context-menu").get("attributes") or {}).get("class") or "").split(),
        timeout=2.0,
    )


def _toolbar_disabled(ctx) -> bool | None:
    return _evalv(ctx, "!!document.getElementById('tb-git-diff')?.disabled")


def _find_tab(ctx, path: str):
    want = _norm(path)
    for tab in ctx.api.tabs().get("tabs") or []:
        if _norm(tab.get("path") or "") == want:
            return tab
    return None


def _wait_file(ctx, path: str, timeout: float = 5.0) -> bool:
    want = _norm(path)
    return bool(
        _poll(
            lambda: _norm(ctx.api.state().get("file") or "") == want,
            timeout=timeout,
        )
    )


def _expanded_dirs(ctx) -> list[str]:
    raw = (ctx.api.state().get("workspace") or {}).get("expandedDirs") or []
    return [_norm(p) for p in raw]


def _title_extra(title: str, path: str) -> str:
    if not title.startswith(path):
        return ""
    return title[len(path) :].strip()


def _install_git_status_counter(ctx) -> int:
    hits = _evalv(
        ctx,
        "(function(){"
        "if(typeof window.__folioGitStatusHits!=='number'){"
        "window.__folioGitStatusHits=0;"
        "window.addEventListener('folio-git-status-changed',function(){"
        "window.__folioGitStatusHits+=1;});"
        "}"
        "return window.__folioGitStatusHits;})()",
    )
    return int(hits or 0)


def _git_status_hits(ctx) -> int:
    hits = _evalv(ctx, "window.__folioGitStatusHits")
    try:
        return int(hits or 0)
    except (TypeError, ValueError):
        return 0


def _git_chip_pressed(ctx) -> bool:
    return (
        _evalv(
            ctx,
            "document.getElementById('vault-filter-git')?.getAttribute('aria-pressed')",
        )
        == "true"
    )


def _filter_bar_hidden(ctx) -> bool:
    return _evalv(ctx, "!!document.getElementById('vault-filter')?.hidden") is True


def run(ctx):
    if not shutil.which("git"):
        with ctx.step("git im PATH"):
            ctx.expect(False, "git nicht im PATH; Szenario braucht das git-Binary")
        return

    repo = None
    repo_norm = ""
    pin_norm = ""
    committed = ""
    second = ""
    unchanged = ""
    neu = ""
    kind = ""
    neuer_ordner = ""
    ordnerlich = ""
    clean = ""
    icon = ""
    aussen = ""
    try:
        with ctx.step("Git-Repo anlegen, nur pinned/ pinnen und aufklappen"):
            try:
                repo = _setup_repo()
            except subprocess.CalledProcessError as exc:
                detail = (exc.stderr or exc.stdout or str(exc)).strip()
                ctx.expect(False, f"git-Aufruf fehlgeschlagen: {detail}")

            repo_norm = _norm(repo)
            pin_norm = f"{repo_norm}/pinned"
            committed = f"{pin_norm}/committed.md"
            second = f"{pin_norm}/second.md"
            unchanged = f"{pin_norm}/unchanged.md"
            neu = f"{pin_norm}/neu.md"
            neuer_ordner = f"{pin_norm}/neuer-ordner"
            kind = f"{neuer_ordner}/kind.md"
            ordnerlich = f"{pin_norm}/neuer-ordnerlich"
            clean = f"{ordnerlich}/clean.md"
            icon = f"{pin_norm}/icon.png"
            aussen = f"{repo_norm}/aussen"

            ctx.api.tabs_close_all()
            ctx.api.mode("view")
            ctx.api.workspace_pin(str(repo / "pinned"), is_directory=True)
            pin_ok = _poll(lambda: _node(ctx, pin_norm) is not None, timeout=5.0)
            ctx.expect(bool(pin_ok), f"Pin-Knoten fehlt nach pin: {_node(ctx, pin_norm)!r}")
            ctx.expect(
                _node(ctx, aussen) is None,
                f"aussen/ darf nicht im Vault stehen (nur pinned/ ist Pin): {_node(ctx, aussen)!r}",
            )

            ctx.expect(_click_row(ctx, pin_norm), "Pin-Ordner-Row nicht klickbar")
            kids = _poll(
                lambda: all(
                    _node(ctx, p) is not None
                    for p in (committed, second, unchanged, neu, neuer_ordner, ordnerlich, icon)
                ),
                timeout=5.0,
            )
            ctx.expect(
                bool(kids),
                f"Lazy-Expand zeigt Kinder nicht: committed={_node(ctx, committed)!r} "
                f"neu={_node(ctx, neu)!r} ordner={_node(ctx, neuer_ordner)!r} "
                f"ordnerlich={_node(ctx, ordnerlich)!r} icon={_node(ctx, icon)!r}",
            )
            ctx.expect(_click_row(ctx, neuer_ordner), "neuer-ordner-Row nicht klickbar")
            kind_ok = _poll(lambda: _node(ctx, kind) is not None, timeout=5.0)
            ctx.expect(bool(kind_ok), f"kind.md nach Expand fehlt: {_node(ctx, kind)!r}")
            ctx.expect(_click_row(ctx, ordnerlich), "neuer-ordnerlich-Row nicht klickbar")
            clean_ok = _poll(lambda: _node(ctx, clean) is not None, timeout=5.0)
            ctx.expect(bool(clean_ok), f"clean.md nach Expand fehlt: {_node(ctx, clean)!r}")

        with ctx.step("Dots erscheinen (modified/untracked/keine + Ordner-Aggregation)"):
            dots = _poll(
                lambda: (
                    (c := _node(ctx, committed))
                    and c.get("gitModified") is True
                    and c.get("gitUntracked") is not True
                    and (n := _node(ctx, neu))
                    and n.get("gitUntracked") is True
                    and n.get("gitModified") is not True
                    and (u := _node(ctx, unchanged))
                    and u.get("gitModified") is not True
                    and u.get("gitUntracked") is not True
                    and (d := _node(ctx, neuer_ordner))
                    and d.get("gitUntracked") is True
                    and d.get("gitModified") is not True
                    and (r := _node(ctx, pin_norm))
                    and r.get("gitModified") is True
                    and r.get("gitUntracked") is not True
                ),
                timeout=GIT_POLL_S,
            )
            c = _node(ctx, committed)
            n = _node(ctx, neu)
            u = _node(ctx, unchanged)
            d = _node(ctx, neuer_ordner)
            r = _node(ctx, pin_norm)
            s = _node(ctx, second)
            png = _node(ctx, icon)
            sib = _node(ctx, ordnerlich)
            ctx.expect(
                bool(dots),
                "Git-Klassen fehlen oder falsch: "
                f"committed={c!r} second={s!r} unchanged={u!r} neu={n!r} "
                f"ordner={d!r} pin={r!r} icon={png!r} ordnerlich={sib!r}",
            )
            ctx.expect(
                bool(s) and s.get("gitModified") is True and s.get("gitUntracked") is not True,
                f"second.md sollte git-modified sein: {s!r}",
            )
            ctx.expect(
                bool(png) and png.get("gitModified") is True and png.get("dataText") != "1",
                f"icon.png sollte git-modified und Nicht-Text sein: {png!r}",
            )
            ctx.expect(
                bool(sib)
                and sib.get("gitModified") is not True
                and sib.get("gitUntracked") is not True,
                f"neuer-ordnerlich darf keinen Status tragen: {sib!r}",
            )

        with ctx.step("Tooltip nennt den Status strukturell und bleibt idempotent"):
            c = _node(ctx, committed)
            n = _node(ctx, neu)
            u = _node(ctx, unchanged)
            ctx.expect(
                bool(c) and bool(n) and bool(u),
                f"Knoten weg: committed={c!r} neu={n!r} unchanged={u!r}",
            )
            c_title = c.get("title") or ""
            n_title = n.get("title") or ""
            u_title = u.get("title") or ""
            ctx.expect(
                c_title.startswith(committed) and len(c_title) > len(committed),
                f"committed.md title muss mit Pfad beginnen und laenger sein: {c_title!r}",
            )
            ctx.expect(
                n_title.startswith(neu) and len(n_title) > len(neu),
                f"neu.md title muss mit Pfad beginnen und laenger sein: {n_title!r}",
            )
            ctx.expect(
                u_title == unchanged,
                f"unchanged.md title muss exakt der Pfad sein: {u_title!r}",
            )
            extra_mod = _title_extra(c_title, committed)
            extra_untracked = _title_extra(n_title, neu)
            ctx.expect(bool(extra_mod), f"committed.md title hat keinen Statuszusatz: {c_title!r}")
            ctx.expect(bool(extra_untracked), f"neu.md title hat keinen Statuszusatz: {n_title!r}")
            ctx.expect(
                extra_mod != extra_untracked,
                f"modified- und untracked-Zusatz duerfen nicht identisch sein: "
                f"{extra_mod!r} vs {extra_untracked!r}",
            )
            ctx.expect(
                c_title.count(extra_mod) == 1,
                f"modified-Zusatz schon vor Refresh doppelt: {c_title!r}",
            )
            ctx.expect(
                n_title.count(extra_untracked) == 1,
                f"untracked-Zusatz schon vor Refresh doppelt: {n_title!r}",
            )

            before_hits = _install_git_status_counter(ctx)
            invoke_ok = _evalv(ctx, "typeof window.__folioInvoke==='function'")
            ctx.expect(invoke_ok is True, "__folioInvoke fehlt, Refresh nicht ausloesbar")
            _evalv(ctx, "window.__folioInvoke('vault_build_tree')", timeout_ms=8000)
            saw_event = _poll(
                lambda: _git_status_hits(ctx) > before_hits,
                timeout=GIT_POLL_S,
            )
            ctx.expect(
                bool(saw_event),
                f"Kein zweiter folio-git-status-changed nach vault_build_tree "
                f"(vorher={before_hits}, jetzt={_git_status_hits(ctx)})",
            )
            after_c = (_node(ctx, committed) or {}).get("title") or ""
            after_n = (_node(ctx, neu) or {}).get("title") or ""
            ctx.expect(
                after_c == c_title,
                f"Tooltip committed.md nach Re-Emit veraendert: "
                f"vorher={c_title!r} nachher={after_c!r}",
            )
            ctx.expect(
                after_n == n_title,
                f"Tooltip neu.md nach Re-Emit veraendert: "
                f"vorher={n_title!r} nachher={after_n!r}",
            )
            ctx.expect(
                after_c.count(extra_mod) == 1,
                f"modified-Zusatz nach Re-Emit doppelt: {after_c!r}",
            )
            ctx.expect(
                after_n.count(extra_untracked) == 1,
                f"untracked-Zusatz nach Re-Emit doppelt: {after_n!r}",
            )

        with ctx.step("Screenshot-Baseline git_status_dots"):
            ready = _poll(
                lambda: (
                    (_node(ctx, committed) or {}).get("gitModified") is True
                    and (_node(ctx, neu) or {}).get("gitUntracked") is True
                    and _node(ctx, kind) is not None
                ),
                timeout=5.0,
            )
            ctx.expect(bool(ready), "DOM vor Dots-Screenshot nicht bereit")
            ctx.screenshot("git_status_dots")

        with ctx.step("Tab-Marker: git links, dirty-Punkt rechts unberührt"):
            ctx.api.tab_open(committed)
            ctx.expect(_wait_file(ctx, committed), f"committed.md nicht offen: {ctx.api.state().get('file')!r}")
            ctx.api.tab_open(unchanged)
            ctx.api.tab_open(second)
            ctx.expect(_wait_file(ctx, second), f"second.md nicht offen: {ctx.api.state().get('file')!r}")
            tab_c = _find_tab(ctx, committed)
            ctx.expect(bool(tab_c), f"committed.md-Tab fehlt: {ctx.api.tabs()!r}")
            ctx.api.tab_activate(tab_c["id"])
            ctx.expect(_wait_file(ctx, committed), "Activate committed.md fehlgeschlagen")
            ctx.api.mode("view")

            c_dom = _poll(
                lambda: (
                    (info := _tab_dom(ctx, committed))
                    and info.get("gitModified")
                    and info.get("hasGitMark")
                    and info
                ),
                timeout=5.0,
            )
            ctx.expect(
                bool(c_dom) and c_dom.get("gitModified") and c_dom.get("hasGitMark"),
                f"committed.md-Tab ohne git-Marker: {c_dom!r}",
            )
            ctx.expect(
                not c_dom.get("hasDirty"),
                f"committed.md ist clean, dirty-Punkt sollte fehlen: {c_dom!r}",
            )
            kids = c_dom.get("childClasses") or []
            ctx.expect(
                kids and _cls_is(kids[0], "tab-git"),
                f"tab-git muss erstes Kind (links) sein: {kids!r}",
            )

            u_dom = _poll(lambda: _tab_dom(ctx, unchanged), timeout=3.0)
            ctx.expect(bool(u_dom), f"unchanged.md-Tab fehlt im DOM: {u_dom!r}")
            ctx.expect(
                not u_dom.get("gitModified") and not u_dom.get("hasGitMark"),
                f"unchanged.md-Tab darf keinen git-Marker haben: {u_dom!r}",
            )

        with ctx.step("Klick auf Tab-Marker oeffnet Diff, wechselt/schliesst den Tab nicht"):
            before_tabs = {
                _norm(t.get("path") or "")
                for t in (ctx.api.tabs().get("tabs") or [])
                if t.get("path")
            }
            before_file = _norm(ctx.api.state().get("file") or "")
            ctx.api.click(f'#tab-bar .tab-item[title="{committed}"] .tab-git')
            opened = _poll(
                lambda: (
                    (st := _diff_state(ctx))
                    and st.get("open")
                    and st.get("virtualActive")
                    and not st.get("regionHidden")
                    and WORK_COMMITTED in (st.get("modified") or "")
                    and WORK_COMMITTED not in (st.get("original") or "")
                    and HEAD_COMMITTED in (st.get("original") or "")
                    and st
                ),
                timeout=GIT_POLL_S,
            )
            st = _diff_state(ctx)
            ctx.expect(
                bool(opened),
                f"Diff nach Tab-Marker-Klick nicht bereit: {st!r}",
            )
            after_file = _norm(ctx.api.state().get("file") or "")
            ctx.expect(
                after_file == before_file == committed,
                f"Marker-Klick hat das Dokument gewechselt: vorher={before_file!r} nachher={after_file!r}",
            )
            after_tabs = {
                _norm(t.get("path") or "")
                for t in (ctx.api.tabs().get("tabs") or [])
                if t.get("path")
            }
            ctx.expect(
                committed in after_tabs and after_tabs == before_tabs,
                f"Marker-Klick hat Tabs veraendert: vorher={before_tabs!r} nachher={after_tabs!r}",
            )
            ctx.screenshot("git_diff_view")

        with ctx.step("Rechte Seite folgt dem offenen dirty Puffer"):
            _close_git_diff(ctx)
            ctx.expect(
                _poll(lambda: not _git_diff_open(ctx), timeout=3.0),
                f"Diff schliesst nicht vor Buffer-Test: {_diff_state(ctx)!r}",
            )
            tab_c = _find_tab(ctx, committed)
            ctx.expect(bool(tab_c), "committed.md-Tab vor Edit weg")
            ctx.api.tab_activate(tab_c["id"])
            ctx.expect(_wait_file(ctx, committed), "committed.md nicht aktiv vor Edit")
            ctx.api.mode("edit")
            try:
                ctx.api.wait("editor.ready", timeout_ms=8000)
            except Exception:
                pass
            disk_text = (ctx.api.editor_text_get() or {}).get("text", "")
            ctx.expect(
                WORK_COMMITTED in disk_text,
                f"Disk-Stand von committed.md unerwartet: {disk_text!r}",
            )
            dirty_text = disk_text.rstrip("\n") + f"\n{DIRTY_LINE}\n"
            ctx.api.editor_text_set(dirty_text)
            dirty_dom = _poll(
                lambda: (
                    (info := _tab_dom(ctx, committed))
                    and info.get("hasDirty")
                    and info.get("hasGitMark")
                    and info
                ),
                timeout=5.0,
            )
            ctx.expect(
                bool(dirty_dom) and dirty_dom.get("hasDirty") and dirty_dom.get("hasGitMark"),
                f"git-Marker und dirty-Punkt muessen getrennt koexistieren: {dirty_dom!r}",
            )
            dirty_kids = dirty_dom.get("childClasses") or []
            git_i = next((i for i, cls in enumerate(dirty_kids) if _cls_is(cls, "tab-git")), None)
            title_i = next((i for i, cls in enumerate(dirty_kids) if _cls_is(cls, "tab-title")), None)
            dirty_i = next((i for i, cls in enumerate(dirty_kids) if _cls_is(cls, "tab-dirty")), None)
            ctx.expect(
                git_i == 0,
                f"tab-git muss auch im dirty-Zustand erstes Kind sein: {dirty_kids!r}",
            )
            ctx.expect(
                title_i is not None and dirty_i is not None and dirty_i > title_i,
                f"tab-dirty muss rechts vom Titel stehen: {dirty_kids!r}",
            )
            ctx.api.click(f'#tab-bar .tab-item[title="{committed}"] .tab-git')
            followed = _poll(
                lambda: (
                    (st := _diff_state(ctx))
                    and st.get("open")
                    and DIRTY_LINE in (st.get("modified") or "")
                    and DIRTY_LINE not in (st.get("original") or "")
                    and st
                ),
                timeout=GIT_POLL_S,
            )
            st = _diff_state(ctx)
            ctx.expect(
                bool(followed),
                f"Rechte Seite folgt dem dirty Puffer nicht: {st!r}",
            )

            _close_git_diff(ctx)
            ctx.api.tab_activate(tab_c["id"])
            ctx.expect(_wait_file(ctx, committed), "committed.md nicht aktiv vor Restore")
            ctx.api.editor_text_set(disk_text)
            clean_tab = _poll(
                lambda: not (_tab_dom(ctx, committed) or {}).get("hasDirty"),
                timeout=5.0,
            )
            if not clean_tab:
                ctx.api.tab_close(tab_c["id"], discard=True)
                ctx.api.tab_open(committed)
                ctx.expect(_wait_file(ctx, committed), "committed.md nach discard/reopen weg")

        with ctx.step("Kontextmenue-Gate: show-changes nur bei git-modified + Text"):
            _close_git_diff(ctx)
            _close_context_menu(ctx)
            ctx.api.right_click(_node_sel(committed))
            show = _poll(
                lambda: (ctx.api.dom('#context-menu .ctx-item[data-act="show-changes"]') or {}).get("exists"),
                timeout=3.0,
            )
            ctx.expect(bool(show), "show-changes fehlt auf committed.md (git-modified + Text)")
            ctx.api.click('#context-menu .ctx-item[data-act="show-changes"]')
            opened = _poll(lambda: _git_diff_open(ctx), timeout=GIT_POLL_S)
            ctx.expect(bool(opened), f"Kontextmenue hat Diff nicht geoeffnet: {_diff_state(ctx)!r}")
            _close_git_diff(ctx)

            ctx.api.right_click(_node_sel(unchanged))
            menu_open = _poll(
                lambda: "open"
                in ((ctx.api.dom("#context-menu").get("attributes") or {}).get("class") or "").split(),
                timeout=3.0,
            )
            ctx.expect(bool(menu_open), "Kontextmenue oeffnet nicht auf unchanged.md")
            unchanged_item = ctx.api.dom('#context-menu .ctx-item[data-act="show-changes"]')
            ctx.expect(
                not unchanged_item.get("exists"),
                f"show-changes darf auf unchanged.md nicht existieren: {unchanged_item!r}",
            )
            _close_context_menu(ctx)

            ctx.api.right_click(_node_sel(neu))
            menu_open = _poll(
                lambda: "open"
                in ((ctx.api.dom("#context-menu").get("attributes") or {}).get("class") or "").split(),
                timeout=3.0,
            )
            ctx.expect(bool(menu_open), "Kontextmenue oeffnet nicht auf neu.md")
            neu_item = ctx.api.dom('#context-menu .ctx-item[data-act="show-changes"]')
            ctx.expect(
                not neu_item.get("exists"),
                f"show-changes darf auf neu.md (nur untracked) nicht existieren: {neu_item!r}",
            )
            _close_context_menu(ctx)

            png = _node(ctx, icon)
            ctx.expect(
                bool(png) and png.get("gitModified") is True and png.get("dataText") != "1",
                f"icon.png Vorbedingung (modified, kein data-text): {png!r}",
            )
            ctx.api.right_click(_node_sel(icon))
            menu_open = _poll(
                lambda: "open"
                in ((ctx.api.dom("#context-menu").get("attributes") or {}).get("class") or "").split(),
                timeout=3.0,
            )
            ctx.expect(bool(menu_open), "Kontextmenue oeffnet nicht auf icon.png")
            png_item = ctx.api.dom('#context-menu .ctx-item[data-act="show-changes"]')
            ctx.expect(
                not png_item.get("exists"),
                f"show-changes darf auf icon.png (modified, aber kein Text) nicht existieren: "
                f"{png_item!r} node={png!r}",
            )
            _close_context_menu(ctx)

        with ctx.step("Diff folgt Dokumentwechsel bzw. schliesst"):
            tab_c = _find_tab(ctx, committed)
            ctx.expect(bool(tab_c), "committed.md-Tab vor Follow-Test weg")
            ctx.api.tab_activate(tab_c["id"])
            ctx.expect(_wait_file(ctx, committed), "committed.md nicht aktiv vor Follow-Test")
            ctx.api.click(f'#tab-bar .tab-item[title="{committed}"] .tab-git')
            ctx.expect(
                _poll(lambda: _git_diff_open(ctx), timeout=GIT_POLL_S),
                f"Diff vor Follow nicht offen: {_diff_state(ctx)!r}",
            )
            # openDocument, nicht Tab-Klick: der wuerde den virtuellen Diff-Tab schliessen.
            ctx.api.open(second, discard=True)
            followed = _poll(
                lambda: (
                    (st := _diff_state(ctx))
                    and st.get("open")
                    and second in (st.get("hint") or "")
                    and WORK_SECOND in (st.get("modified") or "")
                    and WORK_SECOND not in (st.get("original") or "")
                    and st
                ),
                timeout=GIT_POLL_S,
            )
            st = _diff_state(ctx)
            ctx.expect(
                bool(followed),
                f"Diff folgt second.md nicht: file={ctx.api.state().get('file')!r} diff={st!r}",
            )
            ctx.expect(
                _evalv(ctx, "document.body.classList.contains('git-diff-open')") is True,
                "Virtueller Diff-Tab darf beim Follow nicht schliessen",
            )

            ctx.api.open(unchanged, discard=True)
            closed = _poll(lambda: not _git_diff_open(ctx), timeout=GIT_POLL_S)
            st = _diff_state(ctx)
            ctx.expect(
                bool(closed),
                f"Diff bleibt auf unchanged.md stehen: file={ctx.api.state().get('file')!r} diff={st!r}",
            )

        with ctx.step("Toolbar-Aktion enabled nur bei git-modified (kein View-Mode)"):
            tab_c = _find_tab(ctx, committed)
            ctx.expect(bool(tab_c), "committed.md-Tab vor Toolbar-Test weg")
            ctx.api.tab_activate(tab_c["id"])
            ctx.expect(_wait_file(ctx, committed), "committed.md nicht aktiv fuer Toolbar")
            enabled = _poll(lambda: _toolbar_disabled(ctx) is False, timeout=5.0)
            ctx.expect(
                bool(enabled),
                f"#tb-git-diff sollte bei committed.md enabled sein: disabled={_toolbar_disabled(ctx)!r}",
            )
            ctx.expect(
                _evalv(ctx, "document.getElementById('tb-git-diff')?.classList.contains('active')")
                is not True,
                "#tb-git-diff darf keine Mode-Klasse .active tragen",
            )
            ctx.expect(
                _evalv(ctx, "document.body.classList.contains('git-diff-open')") is not True,
                "Toolbar-Test darf keinen Diff-Mode am body erwarten/hinterlassen",
            )

            tab_u = _find_tab(ctx, unchanged)
            ctx.expect(bool(tab_u), "unchanged.md-Tab vor Toolbar-Test weg")
            ctx.api.tab_activate(tab_u["id"])
            ctx.expect(_wait_file(ctx, unchanged), "unchanged.md nicht aktiv fuer Toolbar")
            disabled = _poll(lambda: _toolbar_disabled(ctx) is True, timeout=5.0)
            ctx.expect(
                bool(disabled),
                f"#tb-git-diff sollte bei unchanged.md disabled sein: disabled={_toolbar_disabled(ctx)!r}",
            )

        with ctx.step("Filter nur geaenderte: Auto-Expand, Pin-Scope, Segmentgrenze"):
            _close_git_diff(ctx)
            if _filter_bar_hidden(ctx):
                _click_id(ctx, "vault-filter-toggle")
            ctx.expect(
                _poll(lambda: not _filter_bar_hidden(ctx), timeout=3.0),
                "Filterzeile oeffnet nicht",
            )
            _click_id(ctx, "vault-collapse-all")
            collapsed = _poll(
                lambda: _node(ctx, committed) is None and _node(ctx, kind) is None,
                timeout=5.0,
            )
            ctx.expect(
                bool(collapsed),
                f"collapse-all vor Git-Filter unvollstaendig: "
                f"committed={_node(ctx, committed)!r} kind={_node(ctx, kind)!r} "
                f"expanded={_expanded_dirs(ctx)!r}",
            )

            _click_id(ctx, "vault-filter-git")
            git_on = _poll(
                lambda: (
                    _git_chip_pressed(ctx)
                    and _file_visible(ctx, committed)
                    and _file_visible(ctx, second)
                    and _file_visible(ctx, neu)
                    and _file_visible(ctx, kind)
                    and _file_hidden(ctx, unchanged)
                    and _dir_visible(ctx, neuer_ordner)
                    and _dir_visible(ctx, pin_norm)
                ),
                timeout=GIT_POLL_S,
            )
            ctx.expect(
                bool(git_on),
                "Git-Filter/Auto-Expand falsch: "
                f"unchanged_hidden={_file_hidden(ctx, unchanged)} "
                f"committed={_file_visible(ctx, committed)} "
                f"second={_file_visible(ctx, second)} "
                f"neu={_file_visible(ctx, neu)} "
                f"kind={_file_visible(ctx, kind)} "
                f"ordner={_dir_visible(ctx, neuer_ordner)} "
                f"pin={_dir_visible(ctx, pin_norm)} "
                f"expanded={_expanded_dirs(ctx)!r} "
                f"nodes committed={_node(ctx, committed)!r} kind={_node(ctx, kind)!r}",
            )

            expanded = _expanded_dirs(ctx)
            aussen_hits = [
                p for p in expanded if p == aussen or p.startswith(aussen + "/")
            ]
            ctx.expect(
                not aussen_hits,
                f"Falle (2): Auto-Expand hat Pfade ausserhalb des Pins geoeffnet: "
                f"{aussen_hits!r} expanded={expanded!r}",
            )
            ctx.expect(
                any(p == pin_norm or p.startswith(pin_norm + "/") for p in expanded),
                f"Auto-Expand hat den Pin-Zweig nicht geoeffnet: expanded={expanded!r}",
            )
            ctx.expect(
                any(p == neuer_ordner or p.startswith(neuer_ordner + "/") for p in expanded),
                f"Auto-Expand hat neuer-ordner nicht geoeffnet: expanded={expanded!r}",
            )

            # Segmentgrenze: Geschwister mit gleichem String-Praefix einblenden,
            # dann muss clean.md vf-hidden sein (nicht startswith ohne '/').
            if _node(ctx, clean) is None:
                ctx.expect(_click_row(ctx, ordnerlich), "neuer-ordnerlich nach Filter nicht klickbar")
            prefix_ok = _poll(
                lambda: (
                    (info := _node(ctx, clean)) is not None
                    and info.get("vfHidden") is True
                ),
                timeout=5.0,
            )
            clean_info = _node(ctx, clean)
            sib = _node(ctx, ordnerlich)
            ctx.expect(
                bool(prefix_ok) and (clean_info or {}).get("vfHidden") is True,
                f"Falle (1) Negativ: clean.md muss unter Git-Filter verborgen sein "
                f"(Praefix-Segmentgrenze): clean={clean_info!r} "
                f"ordnerlich={sib!r}",
            )
            ctx.expect(
                not _dir_visible(ctx, ordnerlich),
                f"neuer-ordnerlich ist unveraendert und darf nicht als Treffer gelten: {sib!r}",
            )

            _set_filter_query(ctx, "committed")
            combo = _poll(
                lambda: (
                    _file_visible(ctx, committed)
                    and not _file_visible(ctx, neu)
                    and not _file_visible(ctx, second)
                    and not _file_visible(ctx, unchanged)
                    and not _file_visible(ctx, kind)
                    and _file_hidden(ctx, clean)
                ),
                timeout=4.0,
            )
            ctx.expect(
                bool(combo),
                "Namens+Git-Filter falsch: "
                f"committed={_file_visible(ctx, committed)} "
                f"neu={_file_visible(ctx, neu)} "
                f"second={_file_visible(ctx, second)} "
                f"kind={_file_visible(ctx, kind)} "
                f"clean={_node(ctx, clean)!r}",
            )

            _set_filter_query(ctx, "")
            _click_id(ctx, "vault-filter-git")
            restored = _poll(
                lambda: (
                    _file_visible(ctx, unchanged)
                    and _file_visible(ctx, committed)
                    and _file_visible(ctx, second)
                    and _file_visible(ctx, neu)
                    and _file_visible(ctx, kind)
                    and not _git_chip_pressed(ctx)
                ),
                timeout=5.0,
            )
            ctx.expect(
                bool(restored),
                "Filter-Aus raeumt Sicht nicht: "
                f"unchanged={_file_visible(ctx, unchanged)} "
                f"kind={_file_visible(ctx, kind)} "
                f"gitPressed={_git_chip_pressed(ctx)!r}",
            )

    finally:
        try:
            _close_git_diff(ctx)
        except Exception:
            pass
        try:
            _close_context_menu(ctx)
        except Exception:
            pass
        try:
            ctx.api.eval(
                "typeof window.__folioVaultFilterReset==='function'"
                "&&window.__folioVaultFilterReset()"
            )
        except Exception:
            pass
        try:
            _poll(
                lambda: (not _git_chip_pressed(ctx)) and _filter_bar_hidden(ctx),
                timeout=3.0,
            )
        except Exception:
            pass
        try:
            if _git_chip_pressed(ctx):
                _click_id(ctx, "vault-filter-git")
        except Exception:
            pass
        try:
            committed_tab = _find_tab(ctx, committed) if committed else None
            if committed_tab and committed_tab.get("dirty"):
                ctx.api.tab_activate(committed_tab["id"])
                disk = (REPO_DIR / "pinned" / "committed.md").read_text(encoding="utf-8")
                ctx.api.editor_text_set(disk)
        except Exception:
            pass
        try:
            ctx.api.tabs_close_all()
        except Exception:
            pass
        try:
            if pin_norm:
                ctx.api.workspace_unpin(pin_norm)
        except Exception:
            try:
                if repo is not None:
                    ctx.api.workspace_unpin(str(repo / "pinned"))
            except Exception:
                pass
        shutil.rmtree(REPO_DIR, ignore_errors=True)
        shutil.rmtree(TEMPLATE_DIR, ignore_errors=True)
