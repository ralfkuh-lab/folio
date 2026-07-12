"""UI-Test fuer das Vault-Such-Panel (Etappe S2 + Fix-Paket).

Deckt ab: Strg+Shift+F-Fokus, Treffer-Rendering (<mark>, Zeilen), Aa-Toggle
aendert das Ergebnis (empirisch: camelCase-Payload wird korrekt gemappt),
Edit-Mode-Sprung (Monaco-Selektion), Ctrl+Klick → neuer Tab + korrekter Sprung
trotz Navigation-Restore, View-Mode-Sprung (N-ter Treffer via Find-Bar),
Escape → Baum zurueck.

Statt fester Sleeps wird auf DOM-/State-Bedingungen gepollt; vor DOM-/Screenshot-
Checks laeuft /sync/render.
"""

import os
import sys
import tempfile
import time

TOKEN = "ZQXKN"  # szenariospezifischer, seltener Suchtoken


def _write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def _evalv(ctx, js):
    return ctx.api.eval(js).get("value")


def _set_query(ctx, value):
    js = (
        "(function(){var i=document.getElementById('vault-search-input');"
        "i.value=" + repr(value) + ";i.dispatchEvent(new Event('input'));return true;})()"
    )
    ctx.api.eval(js)


def _group_hits(ctx, fname):
    js = (
        "(function(){var gs=document.querySelectorAll('#vault-search-list .vs-group');"
        "for(var i=0;i<gs.length;i++){var fn=gs[i].querySelector('.vs-fname');"
        "if(fn&&fn.textContent===" + repr(fname) + "){"
        "return gs[i].querySelectorAll('.vs-hit').length;}}return -1;})()"
    )
    return _evalv(ctx, js)


def _poll(ctx, fn, timeout=4.0, interval=0.15):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    return last


def run(ctx):
    initial = ctx.api.state().get("file")
    with tempfile.TemporaryDirectory() as td:
        # notes.md: TOKEN (upper) auf Zeile 2+4, token (lower) auf Zeile 3.
        _write(
            os.path.join(td, "notes.md"),
            "# Notes\nalpha %s one\nbeta %s two\ngamma %s three\n"
            % (TOKEN, TOKEN.lower(), TOKEN),
        )
        _write(os.path.join(td, "more.md"), "extra %s line\n" % TOKEN)
        # Unterordner für den Ordner-Scope-Test (S3).
        _write(os.path.join(td, "sub", "inner.md"), "deep %s here\n" % TOKEN)

        pinned = False
        try:
            with ctx.step("close_all + Dokument in Edit-Mode + pin fixture dir"):
                ctx.api.tabs_close_all()
                ctx.api.open(os.path.join(td, "notes.md"), discard=True)
                ctx.api.mode("edit")
                ctx.api.workspace_pin(td, is_directory=True)
                pinned = True

            with ctx.step("Strg+Shift+F fokussiert das Suchfeld"):
                ctx.api.key("F", {"ctrl": True, "shift": True})
                active = _poll(
                    ctx,
                    lambda: _evalv(ctx, "document.activeElement && document.activeElement.id")
                    == "vault-search-input",
                )
                ctx.expect(active is True, "search input not focused")

            with ctx.step("Suche (case-insensitive) rendert 3 Treffer mit <mark>"):
                _set_query(ctx, TOKEN)
                # Auf das VOLLSTÄNDIGE Streaming-Ergebnis warten (alle 3 Dateien
                # inkl. sub/inner.md), damit der Screenshot deterministisch ist.
                hits = _poll(
                    ctx,
                    lambda: _group_hits(ctx, "notes.md") == 3
                    and _group_hits(ctx, "more.md") == 1
                    and _group_hits(ctx, "inner.md") == 1,
                )
                ctx.expect(hits is True, f"notes.md hits(ci)={_group_hits(ctx, 'notes.md')}")
                ctx.api.sync_render()
                info = _evalv(
                    ctx,
                    "(function(){var g=null,gs=document.querySelectorAll('#vault-search-list .vs-group');"
                    "for(var i=0;i<gs.length;i++){if(gs[i].querySelector('.vs-fname').textContent==='notes.md')g=gs[i];}"
                    "var mark=g.querySelector('.vs-snippet mark');"
                    "var line=g.querySelector('.vs-line');"
                    "var treeHidden=getComputedStyle(document.getElementById('vault-tree')).display==='none';"
                    "return {mark:mark?mark.textContent:null,line:line?line.textContent:null,treeHidden:treeHidden};})()",
                )
                ctx.expect(info.get("treeHidden") is True, "tree must be hidden while searching")
                ctx.expect(info.get("mark") == TOKEN, f"mark={info.get('mark')}")
                ctx.expect(info.get("line") == "2", f"line={info.get('line')}")

            ctx.screenshot("47_search_results")

            with ctx.step("Aa-Toggle (case-sensitive) reduziert auf 2 Treffer"):
                ctx.api.eval(
                    "document.getElementById('vault-search-case')"
                    ".dispatchEvent(new MouseEvent('click',{bubbles:true}))"
                )
                # Vollständiges cs-Ergebnis abwarten (notes 2, more 1, inner 1),
                # damit der spätere Jump-Screenshot deterministisch ist.
                ok = _poll(
                    ctx,
                    lambda: _group_hits(ctx, "notes.md") == 2
                    and _group_hits(ctx, "more.md") == 1
                    and _group_hits(ctx, "inner.md") == 1,
                )
                ctx.expect(ok is True, f"notes.md hits(cs)={_group_hits(ctx, 'notes.md')}")

            with ctx.step("Edit-Mode: Klick auf ersten Treffer selektiert den Token"):
                ctx.api.eval(
                    "(function(){var gs=document.querySelectorAll('#vault-search-list .vs-group');"
                    "for(var i=0;i<gs.length;i++){if(gs[i].querySelector('.vs-fname').textContent==='notes.md'){"
                    "gs[i].querySelector('.vs-hit').dispatchEvent(new MouseEvent('click',{bubbles:true}));return;}}})()"
                )

                def sel_ok():
                    cur = ctx.api.state().get("file") or ""
                    if not cur.replace("\\", "/").endswith("/notes.md"):
                        return None
                    s = _evalv(
                        ctx,
                        "(function(){if(!window.FolioEditor)return{};var s=window.FolioEditor.getSelection();"
                        "return{len:s.length,text:window.FolioEditor.getText().substr(s.start,s.length)};})()",
                    ) or {}
                    return s if s.get("text") == TOKEN else None

                sel = _poll(ctx, sel_ok, timeout=6.0)
                ctx.expect(bool(sel), f"edit-jump selection={sel}")
                ctx.expect(sel.get("len") == 5, f"len={sel.get('len')}")

            ctx.screenshot("47_search_jump")

            with ctx.step("Ctrl+Klick auf more.md-Treffer → neuer Tab + Sprung (Nav-Restore-Skip)"):
                tabs_before = len(ctx.api.tabs().get("tabs") or [])
                ctx.api.eval(
                    "(function(){var gs=document.querySelectorAll('#vault-search-list .vs-group');"
                    "for(var i=0;i<gs.length;i++){if(gs[i].querySelector('.vs-fname').textContent==='more.md'){"
                    "gs[i].querySelector('.vs-hit').dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}));return;}}})()"
                )

                def more_ok():
                    cur = ctx.api.state().get("file") or ""
                    if not cur.replace("\\", "/").endswith("/more.md"):
                        return None
                    s = _evalv(
                        ctx,
                        "(function(){if(!window.FolioEditor)return{};var s=window.FolioEditor.getSelection();"
                        "return{len:s.length,text:window.FolioEditor.getText().substr(s.start,s.length)};})()",
                    ) or {}
                    return s if s.get("text") == TOKEN else None

                sel2 = _poll(ctx, more_ok, timeout=6.0)
                ctx.expect(bool(sel2), f"ctrl-click jump selection={sel2}")
                tabs_after = len(ctx.api.tabs().get("tabs") or [])
                ctx.expect(tabs_after == tabs_before + 1, f"tabs {tabs_before}->{tabs_after}")

            with ctx.step("View-Mode: Klick auf 3. Treffer → Find-Bar aktiviert 3/3"):
                # Aa aus (wieder case-insensitive → 3 Treffer).
                ctx.api.eval(
                    "document.getElementById('vault-search-case')"
                    ".dispatchEvent(new MouseEvent('click',{bubbles:true}))"
                )
                _poll(ctx, lambda: _group_hits(ctx, "notes.md") == 3)
                # Isolierter Zustand: ein Tab, notes.md im View-Mode (die
                # Suchergebnisse im Panel bleiben erhalten).
                ctx.api.tabs_close_all()
                ctx.api.open(os.path.join(td, "notes.md"), discard=True)
                ctx.api.mode("view")
                # 3. Treffer (Index 2) der notes.md-Gruppe klicken.
                ctx.api.eval(
                    "(function(){var gs=document.querySelectorAll('#vault-search-list .vs-group');"
                    "for(var i=0;i<gs.length;i++){if(gs[i].querySelector('.vs-fname').textContent==='notes.md'){"
                    "var hs=gs[i].querySelectorAll('.vs-hit');hs[2].dispatchEvent(new MouseEvent('click',{bubbles:true}));return;}}})()"
                )

                def find_ok():
                    st = _evalv(
                        ctx,
                        "(function(){var b=document.getElementById('find-bar');"
                        "var i=document.getElementById('find-input');"
                        "var c=document.getElementById('find-counter');"
                        "return{open:b&&b.classList.contains('open'),term:i?i.value:'',counter:c?c.textContent:''};})()",
                    ) or {}
                    return st if (st.get("open") and st.get("counter") == "3/3") else None

                fs = _poll(ctx, find_ok, timeout=5.0)
                ctx.expect(bool(fs), f"view-jump did not reach 3/3: {find_ok()}")
                ctx.expect(fs.get("term") == TOKEN, f"find term={fs.get('term')}")

            with ctx.step("Escape (Nutzerpfad) → Baum wieder sichtbar"):
                # Realer Pfad: Feld per Strg+Shift+F fokussieren, dann Escape.
                ctx.api.key("F", {"ctrl": True, "shift": True})
                ctx.api.eval(
                    "document.getElementById('vault-search-input')"
                    ".dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
                )
                back = _poll(
                    ctx,
                    lambda: _evalv(
                        ctx,
                        "!document.getElementById('vault-region').classList.contains('vault-searching')"
                        "&&getComputedStyle(document.getElementById('vault-tree')).display!=='none'",
                    ),
                )
                ctx.expect(back is True, "tree not restored after Escape")

            with ctx.step("Ordner-Scope via Kontextmenü (bei aktiver Query) beschränkt auf sub/"):
                td_norm = td.replace("\\", "/")
                sub_norm = td_norm + "/sub"
                sub_sel = '#vault-tree li.node[data-path="%s"]' % sub_norm
                # Pin-Ordner im Baum aufklappen, bis der Unterordner sichtbar ist.
                ctx.api.click('#vault-tree li.node[data-path="%s"] > .row' % td_norm)
                appeared = _poll(
                    ctx,
                    lambda: _evalv(ctx, "!!document.querySelector('%s')" % sub_sel),
                )
                ctx.expect(appeared is True, "sub-Ordner nicht im Baum aufgetaucht")

                # Query VORAB ins Feld setzen (ohne input-Event, Baum bleibt
                # sichtbar) → der Kontextmenü-Klick trifft den Re-Trigger-Pfad.
                ctx.api.eval(
                    "document.getElementById('vault-search-input').value=%s" % repr(TOKEN)
                )
                # Rechtsklick → Kontextmenue → „In diesem Ordner suchen".
                ctx.api.right_click(sub_sel)
                _poll(
                    ctx,
                    lambda: _evalv(
                        ctx,
                        "!!document.querySelector('#context-menu.open .ctx-item[data-act=\\'search-folder\\']')",
                    ),
                )
                ctx.api.click("#context-menu .ctx-item[data-act=\"search-folder\"]")

                # Re-Trigger muss unmittelbar scoped suchen: Chip 'sub' + NUR
                # inner.md, KEINE root-Dateien (Exklusivität).
                scoped = _poll(
                    ctx,
                    lambda: _evalv(
                        ctx,
                        "(function(){var n=document.querySelector('#vault-search-scope .vs-scope-name');"
                        "return n?n.textContent:null;})()",
                    )
                    == "sub"
                    and _group_hits(ctx, "inner.md") == 1
                    and _group_hits(ctx, "notes.md") == -1
                    and _group_hits(ctx, "more.md") == -1,
                )
                ctx.expect(
                    scoped is True,
                    f"scope inner={_group_hits(ctx, 'inner.md')} "
                    f"notes={_group_hits(ctx, 'notes.md')} more={_group_hits(ctx, 'more.md')}",
                )

            ctx.screenshot("47_folder_scope")

            with ctx.step("Chip-× entfernt den Scope → wieder vault-weit"):
                ctx.api.eval(
                    "document.querySelector('#vault-search-scope .vs-scope-x')"
                    ".dispatchEvent(new MouseEvent('click',{bubbles:true}))"
                )
                widened = _poll(
                    ctx,
                    lambda: _group_hits(ctx, "notes.md") == 3
                    and _group_hits(ctx, "inner.md") == 1,
                )
                ctx.expect(
                    widened is True,
                    f"nach Chip-× notes.md={_group_hits(ctx, 'notes.md')} "
                    f"inner.md={_group_hits(ctx, 'inner.md')}",
                )

        finally:
            if pinned:
                had_error = sys.exc_info()[0] is not None
                try:
                    ctx.api.workspace_unpin(td)
                except Exception:
                    if not had_error:
                        raise
            ctx.api.tabs_close_all()
            if initial:
                try:
                    ctx.api.open(initial, discard=True)
                except Exception:
                    pass
