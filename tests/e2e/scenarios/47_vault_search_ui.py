"""UI-Test fuer das Vault-Such-Panel (Etappe S4 — Dialog-first-Flow).

S4 verlagert die Bedienung von der Inline-Zeile in einen modalen Dialog
(`#vault-search-dialog`, `#vsd-*`-Felder). Der linke Rail zeigt nur noch einen
Summary-Button (`#vault-search-summary`) + die Ergebnisse. Dieses Szenario ist
gegen DEN neuen Frontend-Stand geschrieben (nicht die alte Inline-Zeile).

Deckt ab:
- Dialog oeffnen (Strg+Shift+F-Pfad + Summary-Klick), Felder setzen, Submit,
  Ergebnis-Rendering (<mark>, Gruppen).
- Cancel/Reopen: Draft verworfen, committed Lauf/Summary unveraendert.
- Folder-Draft ueber das Kontextmenue („In diesem Ordner suchen" → Dialog mit
  Folder-Option) → scoped Ergebnis nach Submit.
- Regex-Lauf inkl. View-Mode-Sprung (Jump.term = gematchter Text, nicht Pattern).
- Auto-Collapse ab >10 Treffergruppen; Collapse-All/Expand-All; Nutzer-Override
  (nicht-streaming: Expand-All setzt Modus expanded).
- Spinner (`vs-running`): waehrend eines Laufs gesetzt, danach entfernt
  (MutationObserver-Beleg + End-Zustands-Check).
- Sprung ohne Save-Prompt bei dirty Tab (OpenTabs-Scope): dirty bleibt dirty,
  kein `#unsaved-dialog`.
- Scope „Gefilterte Dateien" (Referenzfaelle R1–R8): Filtermenge aus dem
  Vault-Filter (Query, Bereich, `.md`, `.*`, `vaultShowHidden`), Dialog-
  Dateityp als Schnittmenge, Option deaktiviert bei 1-Zeichen-Query.

Statt fester Sleeps wird auf DOM-/State-Bedingungen gepollt; vor Screenshots
laeuft /sync/render.
"""

import json
import os
import shutil
import sys
import tempfile
import time

TOKEN = "ZQXKN"        # Basis-/Regex-Token
MANY = "ZZMANY"        # Auto-Collapse-Token (>10 Dateien)
DIRTY = "ZZDIRTYBUF"   # nur im Editor-Puffer, nicht auf Platte
MANY_FILES = 12        # > AUTO_COLLAPSE_THRESHOLD (10)


def _write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def _evalv(ctx, js):
    return ctx.api.eval(js).get("value")


def _poll(ctx, fn, timeout=5.0, interval=0.15):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    return last


def _count(ctx, sel):
    return _evalv(ctx, "document.querySelectorAll(%s).length" % json.dumps(sel))


def _group_hits(ctx, fname):
    js = (
        "(function(){var gs=document.querySelectorAll('#vault-search-list .vs-group');"
        "for(var i=0;i<gs.length;i++){var fn=gs[i].querySelector('.vs-fname');"
        "if(fn&&fn.textContent===" + json.dumps(fname) + "){"
        "return gs[i].querySelectorAll('.vs-hit').length;}}return -1;})()"
    )
    return _evalv(ctx, js)


def _dialog_visible(ctx):
    return _evalv(
        ctx, "!document.getElementById('vault-search-dialog').hidden"
    ) is True


def _open_dialog_via_summary(ctx):
    ctx.api.eval(
        "document.getElementById('vault-search-summary')"
        ".dispatchEvent(new MouseEvent('click',{bubbles:true}))"
    )
    return _poll(ctx, lambda: _dialog_visible(ctx))


def _fill_and_submit(
    ctx,
    query,
    case=False,
    word=False,
    regex=False,
    file_filter="allText",
    custom_ext="",
    scope="vault",
):
    """Setzt die Dialog-Felder direkt (submitDialog liest DOM-Werte live) und
    loest den Submit-Button aus. change-Events treiben nur die Disable-Logik."""
    js = (
        "(function(){"
        "var q=document.getElementById('vsd-query');q.value=%(q)s;"
        "var c=document.getElementById('vsd-case');c.checked=%(case)s;"
        "c.dispatchEvent(new Event('change',{bubbles:true}));"
        "var r=document.getElementById('vsd-regex');r.checked=%(regex)s;"
        "r.dispatchEvent(new Event('change',{bubbles:true}));"
        "var w=document.getElementById('vsd-word');w.checked=%(word)s;"
        "w.dispatchEvent(new Event('change',{bubbles:true}));"
        "var fr=document.querySelector('input[name=\"vsd-filter\"][value=%(ff)s]');"
        "if(fr){fr.checked=true;fr.dispatchEvent(new Event('change',{bubbles:true}));}"
        "var ext=document.getElementById('vsd-custom-ext');ext.value=%(ext)s;"
        "var sc=document.querySelector('input[name=\"vsd-scope\"][value=%(scope)s]');"
        "if(sc){sc.checked=true;sc.dispatchEvent(new Event('change',{bubbles:true}));}"
        "document.getElementById('vsd-submit')"
        ".dispatchEvent(new MouseEvent('click',{bubbles:true}));"
        "return true;})()"
    ) % {
        "q": json.dumps(query),
        "case": "true" if case else "false",
        "regex": "true" if regex else "false",
        "word": "true" if word else "false",
        "ff": json.dumps(file_filter),
        "ext": json.dumps(custom_ext),
        "scope": json.dumps(scope),
    }
    ctx.api.eval(js)


def _wait_dialog_closed(ctx):
    return _poll(ctx, lambda: _dialog_visible(ctx) is False)


def _summary_text(ctx):
    return _evalv(
        ctx,
        "(function(){var t=document.getElementById('vault-search-summary-text');"
        "return t?t.textContent:null;})()",
    )


def _click_id(ctx, el_id):
    ctx.api.eval(
        "document.getElementById(%s)"
        ".dispatchEvent(new MouseEvent('click',{bubbles:true}))" % json.dumps(el_id)
    )


def _set_filter_query(ctx, query):
    js = (
        "(function(){var el=document.getElementById('vault-filter-input');"
        "if(!el)return false;el.value=%s;"
        "el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()"
        % json.dumps(query)
    )
    ctx.expect(_evalv(ctx, js) is True, "Filter-Input nicht gesetzt")
    # Filter-Input ist 150 ms entprellt; der Suchscope liest die committed
    # Query. Kein DOM-Signal dafuer (Bereich + .md ist auch mit alter Query
    # waehlbar) → Entprellung sicher abwarten.
    time.sleep(0.4)


def _chip_pressed(ctx, el_id):
    return _evalv(
        ctx,
        "document.getElementById(%s).getAttribute('aria-pressed')" % json.dumps(el_id),
    ) == "true"


def _toggle_chip(ctx, el_id, on):
    if _chip_pressed(ctx, el_id) != on:
        _click_id(ctx, el_id)
    ctx.expect(
        _poll(ctx, lambda: _chip_pressed(ctx, el_id) == on) is True,
        f"Chip {el_id} nicht {'an' if on else 'aus'}",
    )


def _filtered_radio_disabled(ctx):
    return _evalv(
        ctx,
        "document.querySelector('input[name=\"vsd-scope\"][value=\"filtered\"]').disabled",
    )


def _filtered_names(ctx, file_filter="allText"):
    """Sucht `TODO` im Scope „Gefilterte Dateien" und liefert die Dateinamen
    der Treffergruppen. Vorher wird der Suchmodus verlassen (Status leer),
    damit das Ende genau dieses Laufs erkennbar ist."""
    _click_id(ctx, "vault-search-exit")
    # Der Filter-Input ist 150 ms entprellt und die Verfuegbarkeit wird beim
    # Oeffnen bestimmt: Dialog (idempotent) neu befuellen, bis waehlbar.
    ctx.expect(
        _poll(
            ctx,
            lambda: _open_dialog_via_summary(ctx) is True
            and _filtered_radio_disabled(ctx) is False,
        )
        is True,
        "Option 'Gefilterte Dateien' bleibt deaktiviert",
    )
    _fill_and_submit(ctx, "TODO", file_filter=file_filter, scope="filtered")
    ctx.expect(_wait_dialog_closed(ctx) is True, "Dialog blieb nach Submit offen")

    def done():
        st = _evalv(
            ctx,
            "(function(){var s=document.getElementById('vault-search-status');"
            "return {text:s.textContent,running:s.classList.contains('vs-running')};})()",
        )
        return bool(st and st.get("text") and not st.get("running"))

    ctx.expect(_poll(ctx, done) is True, "Suchlauf wurde nicht fertig")
    names = _evalv(
        ctx,
        "Array.from(document.querySelectorAll('#vault-search-list .vs-fname'))"
        ".map(function(e){return e.textContent;})",
    )
    return sorted(names or [])


def run(ctx):
    initial = ctx.api.state().get("file")
    with tempfile.TemporaryDirectory() as td:
        _write(
            os.path.join(td, "notes.md"),
            "# Notes\nalpha %s one\nbeta %s two\ngamma %s three\n" % (TOKEN, TOKEN, TOKEN),
        )
        _write(os.path.join(td, "more.md"), "extra %s line\n" % TOKEN)
        _write(os.path.join(td, "sub", "inner.md"), "deep %s here\n" % TOKEN)
        # >10 Treffer-Dateien fuer Auto-Collapse (eigener Token).
        for i in range(MANY_FILES):
            _write(
                os.path.join(td, "many", "m%02d.md" % i),
                "row %s line\n" % MANY,
            )

        pinned = False
        r_pinned = False
        r_td = None
        try:
            with ctx.step("close_all + notes.md im Edit-Mode + pin fixture dir"):
                ctx.api.tabs_close_all()
                ctx.api.open(os.path.join(td, "notes.md"), discard=True)
                ctx.api.mode("edit")
                ctx.api.workspace_pin(td, is_directory=True)
                pinned = True

            with ctx.step("Strg+Shift+F oeffnet den Such-Dialog"):
                ctx.api.key("F", {"ctrl": True, "shift": True})
                opened = _poll(ctx, lambda: _dialog_visible(ctx))
                ctx.expect(opened is True, "dialog not opened by Ctrl+Shift+F")
                # Query-Feld fokussiert?
                focused = _evalv(
                    ctx, "document.activeElement && document.activeElement.id"
                )
                ctx.expect(focused == "vsd-query", f"query not focused: {focused}")

            with ctx.step("Dialog: Query setzen (Screenshot des offenen Dialogs)"):
                # Query vorbefuellen, damit der Dialog-Screenshot deterministisch ist.
                ctx.api.eval(
                    "document.getElementById('vsd-query').value=%s" % json.dumps(TOKEN)
                )

            ctx.screenshot("47_search_dialog")

            with ctx.step("Submit (Vault, allText) → 3 Gruppen mit <mark>"):
                _fill_and_submit(ctx, TOKEN, scope="vault")
                closed = _wait_dialog_closed(ctx)
                ctx.expect(closed is True, "dialog stayed open after valid submit")
                got = _poll(
                    ctx,
                    lambda: _group_hits(ctx, "notes.md") == 3
                    and _group_hits(ctx, "more.md") == 1
                    and _group_hits(ctx, "inner.md") == 1,
                )
                ctx.expect(
                    got is True,
                    f"notes={_group_hits(ctx, 'notes.md')} more={_group_hits(ctx, 'more.md')} "
                    f"inner={_group_hits(ctx, 'inner.md')}",
                )
                # Summary spiegelt den committed Begriff.
                ctx.expect(_summary_text(ctx) == TOKEN, f"summary={_summary_text(ctx)}")
                info = _evalv(
                    ctx,
                    "(function(){var gs=document.querySelectorAll('#vault-search-list .vs-group');"
                    "var g=null;for(var i=0;i<gs.length;i++){if(gs[i].querySelector('.vs-fname').textContent==='notes.md')g=gs[i];}"
                    "var mark=g.querySelector('.vs-snippet mark');"
                    "var line=g.querySelector('.vs-line');"
                    "var treeHidden=getComputedStyle(document.getElementById('vault-tree')).display==='none';"
                    "return {mark:mark?mark.textContent:null,line:line?line.textContent:null,treeHidden:treeHidden};})()",
                )
                ctx.expect(info.get("treeHidden") is True, "tree must be hidden while searching")
                ctx.expect(info.get("mark") == TOKEN, f"mark={info.get('mark')}")
                ctx.expect(info.get("line") == "2", f"line={info.get('line')}")

            with ctx.step("Deterministische Sortierung (name) vor dem Screenshot"):
                # [Sol-Rev S6#3] Seit S6 laeuft der Walk parallel → die Ankunfts-/
                # Completion-Order (Sortiermodus 'none') ist nichtdeterministisch.
                # Der Screenshot 47_search_results ist damit nur baseline-stabil,
                # wenn vorher auf einen deterministischen Modus geschaltet wird.
                # Sort 'name' ordnet die drei Gruppen alphabetisch nach Dateiname
                # (inner.md < more.md < notes.md) — unabhaengig von der Ankunft.
                # HINWEIS: Nach dieser Aenderung muss die Baseline 47_search_results
                # unter Linux (run-e2e.sh --update-baselines) neu erzeugt werden.
                # Erst sicherstellen, dass der Lauf fertig ist (kein Spinner).
                spinner_gone = _poll(
                    ctx,
                    lambda: _evalv(
                        ctx,
                        "document.getElementById('vault-search-status')"
                        ".classList.contains('vs-running')",
                    )
                    is False,
                )
                ctx.expect(spinner_gone is True, "spinner still running before results screenshot")
                expected_order = ["inner.md", "more.md", "notes.md"]

                def _fname_order():
                    return _evalv(
                        ctx,
                        "(function(){return Array.from(document.querySelectorAll("
                        "'#vault-search-list .vs-group .vs-fname')).map("
                        "function(e){return e.textContent;});})()",
                    )

                def _sort_active():
                    return _evalv(
                        ctx,
                        "document.getElementById('vault-search-sort')"
                        ".classList.contains('active')",
                    )

                # Sort-Button zyklisch (none→name→path→none) klicken, bis wir im
                # 'name'-Modus sind (Button aktiv UND alphabetische Reihenfolge).
                # Robust gegen einen aus einem frueheren Lauf persistierten Modus.
                reached = False
                for _ in range(4):
                    if _sort_active() is True and _fname_order() == expected_order:
                        reached = True
                        break
                    ctx.api.eval(
                        "document.getElementById('vault-search-sort')"
                        ".dispatchEvent(new MouseEvent('click',{bubbles:true}))"
                    )
                    time.sleep(0.12)
                ctx.expect(
                    reached,
                    f"deterministischer name-Sort nicht erreicht: active={_sort_active()} "
                    f"order={_fname_order()}",
                )

            ctx.screenshot("47_search_results")

            with ctx.step("Sort=path blendet Pfade automatisch ein (Einbahn-Kopplung)"):
                # [S7] sort=path ohne sichtbare Pfade ist nicht nachvollziehbar
                # (die Reihenfolge waere unerklaerlich). Der Wechsel auf 'path'
                # blendet die Pfadzeile daher einmalig ein; verlaesst der User
                # 'path' wieder, bleiben die Pfade sichtbar (keine Rueck-Kopplung).
                # Am Ende raeumen wir exakt auf den Vorzustand (sort=name, Pfade
                # aus) zurueck, damit spaetere Ergebnislisten-Screenshots
                # (47_folder_scope) stabil bleiben — showPaths/sort persistieren
                # ueber Suchlaeufe hinweg.
                def _paths_pressed():
                    return _evalv(
                        ctx,
                        "document.getElementById('vault-search-paths')"
                        ".getAttribute('aria-pressed')",
                    )

                def _click_sort():
                    ctx.api.eval(
                        "document.getElementById('vault-search-sort')"
                        ".dispatchEvent(new MouseEvent('click',{bubbles:true}))"
                    )
                    time.sleep(0.12)

                # Vorbedingung: aus dem name-Sort-Block sind die Pfade aus.
                ctx.expect(
                    _count(ctx, "#vault-search-list .vs-fpath") == 0
                    and _paths_pressed() == "false",
                    f"Pfade unerwartet sichtbar vor path-Sort: pressed={_paths_pressed()}",
                )

                # name → path: Pfadzeile automatisch eingeblendet + Emphasis-Klasse.
                _click_sort()
                fpaths_on = _poll(
                    ctx, lambda: _count(ctx, "#vault-search-list .vs-fpath") > 0
                )
                ctx.expect(fpaths_on is True, "path-Sort blendete die Pfadzeile nicht ein")
                ctx.expect(
                    _paths_pressed() == "true",
                    "paths-Toggle nicht gedrueckt nach path-Sort",
                )
                ctx.expect(
                    _evalv(
                        ctx,
                        "document.getElementById('vault-search-list')"
                        ".classList.contains('vs-sort-path')",
                    )
                    is True,
                    "Emphasis-Klasse vs-sort-path fehlt bei path+showPaths",
                )

                # path → none: keine Rueck-Kopplung, Pfade bleiben sichtbar.
                _click_sort()
                ctx.expect(
                    _count(ctx, "#vault-search-list .vs-fpath") > 0
                    and _paths_pressed() == "true",
                    "Rueck-Kopplung: Pfade beim Verlassen von 'path' ausgeblendet",
                )

                # Aufraeumen auf den Vorzustand: Pfade aus, dann sort none → name.
                ctx.api.eval(
                    "document.getElementById('vault-search-paths')"
                    ".dispatchEvent(new MouseEvent('click',{bubbles:true}))"
                )
                time.sleep(0.12)
                _click_sort()  # none → name (Kopplung greift nur bei 'path')
                restored = _poll(
                    ctx,
                    lambda: _count(ctx, "#vault-search-list .vs-fpath") == 0
                    and _fname_order() == expected_order
                    and _sort_active() is True,
                )
                ctx.expect(
                    restored is True,
                    f"Vorzustand nicht wiederhergestellt: pressed={_paths_pressed()} "
                    f"order={_fname_order()}",
                )

            with ctx.step("Cancel/Reopen: Draft verworfen, committed Lauf unveraendert"):
                groups_before = _count(ctx, "#vault-search-list .vs-group")
                _open_dialog_via_summary(ctx)
                # Draft veraendern …
                ctx.api.eval(
                    "document.getElementById('vsd-query').value='DRAFTONLY'"
                )
                # … dann Abbrechen.
                ctx.api.eval(
                    "document.getElementById('vsd-cancel')"
                    ".dispatchEvent(new MouseEvent('click',{bubbles:true}))"
                )
                ctx.expect(_wait_dialog_closed(ctx) is True, "cancel did not close dialog")
                # Committed State unangetastet.
                ctx.expect(_summary_text(ctx) == TOKEN, f"summary changed: {_summary_text(ctx)}")
                ctx.expect(
                    _count(ctx, "#vault-search-list .vs-group") == groups_before,
                    "committed results changed after cancel",
                )
                # Reopen zeigt wieder den committed Begriff (Draft verworfen).
                _open_dialog_via_summary(ctx)
                qv = _evalv(ctx, "document.getElementById('vsd-query').value")
                ctx.expect(qv == TOKEN, f"draft not discarded on reopen: {qv!r}")
                ctx.api.eval(
                    "document.getElementById('vsd-cancel')"
                    ".dispatchEvent(new MouseEvent('click',{bubbles:true}))"
                )
                _wait_dialog_closed(ctx)

            with ctx.step("Auto-Collapse ab >10 Gruppen + Spinner-Beleg"):
                _open_dialog_via_summary(ctx)
                # MutationObserver: haelt fest, ob vs-running je gesetzt war.
                ctx.api.eval(
                    "(function(){window.__vsRunSeen=false;"
                    "var el=document.getElementById('vault-search-status');"
                    "if(window.__vsMo)window.__vsMo.disconnect();"
                    "var mo=new MutationObserver(function(){"
                    "if(el.classList.contains('vs-running'))window.__vsRunSeen=true;});"
                    "mo.observe(el,{attributes:true,attributeFilter:['class']});"
                    "window.__vsMo=mo;return true;})()"
                )
                _fill_and_submit(ctx, MANY, scope="vault")
                ctx.expect(_wait_dialog_closed(ctx) is True, "dialog stayed open")
                # Alle 12 Gruppen eingetroffen …
                all_in = _poll(
                    ctx,
                    lambda: _count(ctx, "#vault-search-list .vs-group") == MANY_FILES,
                )
                ctx.expect(all_in is True, f"groups={_count(ctx, '#vault-search-list .vs-group')}")
                # … und wegen >10 alle eingeklappt.
                collapsed = _poll(
                    ctx,
                    lambda: _count(ctx, "#vault-search-list .vs-caret.collapsed") == MANY_FILES,
                )
                ctx.expect(
                    collapsed is True,
                    f"collapsed carets={_count(ctx, '#vault-search-list .vs-caret.collapsed')}",
                )
                ctx.expect(
                    _count(ctx, "#vault-search-list .vs-hits[hidden]") == MANY_FILES,
                    "hit lists not hidden while collapsed",
                )
                # Spinner: war gesetzt (Observer), ist jetzt entfernt.
                run_seen = _poll(ctx, lambda: _evalv(ctx, "window.__vsRunSeen") is True)
                ctx.expect(run_seen is True, "vs-running was never observed during run")
                ctx.expect(
                    _evalv(
                        ctx,
                        "document.getElementById('vault-search-status')"
                        ".classList.contains('vs-running')",
                    )
                    is False,
                    "vs-running still set after done",
                )

            with ctx.step("Expand-All / Collapse-All (Nutzer-Override, nicht-streaming)"):
                ctx.api.eval(
                    "document.getElementById('vault-search-expand-all')"
                    ".dispatchEvent(new MouseEvent('click',{bubbles:true}))"
                )
                expanded = _poll(
                    ctx,
                    lambda: _count(ctx, "#vault-search-list .vs-caret.collapsed") == 0,
                )
                ctx.expect(expanded is True, "expand-all did not expand all groups")
                ctx.api.eval(
                    "document.getElementById('vault-search-collapse-all')"
                    ".dispatchEvent(new MouseEvent('click',{bubbles:true}))"
                )
                recollapsed = _poll(
                    ctx,
                    lambda: _count(ctx, "#vault-search-list .vs-caret.collapsed") == MANY_FILES,
                )
                ctx.expect(recollapsed is True, "collapse-all did not collapse all groups")

            with ctx.step("Regex-Lauf + View-Mode-Sprung (Jump-Term = gematchter Text)"):
                # Isolierter Zustand: notes.md allein im View-Mode.
                ctx.api.tabs_close_all()
                ctx.api.open(os.path.join(td, "notes.md"), discard=True)
                ctx.api.mode("view")
                _open_dialog_via_summary(ctx)
                # Pattern matcht das TOKEN literal (ZQXKN), aber ueber Regex.
                _fill_and_submit(ctx, "ZQ.KN", regex=True, scope="vault")
                ctx.expect(_wait_dialog_closed(ctx) is True, "regex submit kept dialog open")
                got = _poll(ctx, lambda: _group_hits(ctx, "notes.md") == 3)
                ctx.expect(got is True, f"regex notes hits={_group_hits(ctx, 'notes.md')}")
                # Summary zeigt das Regex-Glyph.
                ctx.expect(
                    _evalv(
                        ctx,
                        "(function(){var o=document.getElementById('vault-search-summary-opts');"
                        "return o?o.textContent.indexOf('.*')>=0:false;})()",
                    )
                    is True,
                    "regex glyph missing in summary",
                )
                # Ersten Treffer klicken → Find-Bar mit dem gematchten Literal (nicht dem Pattern).
                ctx.api.eval(
                    "(function(){var gs=document.querySelectorAll('#vault-search-list .vs-group');"
                    "for(var i=0;i<gs.length;i++){if(gs[i].querySelector('.vs-fname').textContent==='notes.md'){"
                    "gs[i].querySelector('.vs-hit').dispatchEvent(new MouseEvent('click',{bubbles:true}));return;}}})()"
                )

                def find_ok():
                    st = _evalv(
                        ctx,
                        "(function(){var b=document.getElementById('find-bar');"
                        "var i=document.getElementById('find-input');"
                        "return{open:b&&b.classList.contains('open'),term:i?i.value:''};})()",
                    ) or {}
                    return st if (st.get("open") and st.get("term") == TOKEN) else None

                fs = _poll(ctx, find_ok, timeout=6.0)
                ctx.expect(bool(fs), f"regex view-jump term not literal: {find_ok()}")
                # Find-Bar wieder schliessen, bevor der naechste Schritt laeuft.
                ctx.api.find_close()

            with ctx.step("OpenTabs: Sprung im dirty Tab ohne Save-Prompt"):
                ctx.api.tabs_close_all()
                ctx.api.open(os.path.join(td, "notes.md"), discard=True)
                ctx.api.mode("edit")
                # Puffer dirty machen: Treffer existiert NUR im Editor, nicht auf Platte.
                ctx.api.editor_text_set("# Dirty\n%s here\nmore\n" % DIRTY)
                dirty_now = _poll(ctx, lambda: ctx.api.state().get("dirty") is True)
                ctx.expect(dirty_now is True, "editor not dirty after edit")
                _open_dialog_via_summary(ctx)
                _fill_and_submit(ctx, DIRTY, scope="openTabs")
                ctx.expect(_wait_dialog_closed(ctx) is True, "openTabs submit kept dialog open")
                found = _poll(ctx, lambda: _group_hits(ctx, "notes.md") == 1)
                ctx.expect(found is True, f"openTabs buffer hits={_group_hits(ctx, 'notes.md')}")
                # Treffer klicken → Sprung im aktiven Tab, KEIN openDocument/Reload.
                ctx.api.eval(
                    "(function(){var gs=document.querySelectorAll('#vault-search-list .vs-group');"
                    "for(var i=0;i<gs.length;i++){if(gs[i].querySelector('.vs-fname').textContent==='notes.md'){"
                    "gs[i].querySelector('.vs-hit').dispatchEvent(new MouseEvent('click',{bubbles:true}));return;}}})()"
                )

                def jumped_ok():
                    sel = _evalv(
                        ctx,
                        "(function(){if(!window.FolioEditor)return null;"
                        "var s=window.FolioEditor.getSelection();"
                        "return window.FolioEditor.getText().substr(s.start,s.length);})()",
                    )
                    return sel == DIRTY

                jumped = _poll(ctx, jumped_ok, timeout=6.0)
                ctx.expect(jumped is True, "jump did not select the dirty-buffer match")
                # Kein Unsaved-Dialog, Puffer bleibt dirty + Inhalt unveraendert.
                ctx.expect(
                    _evalv(
                        ctx,
                        "(function(){var d=document.getElementById('unsaved-dialog');"
                        "return d?!d.hidden:false;})()",
                    )
                    is False,
                    "unsaved-dialog appeared on dirty-tab jump",
                )
                ctx.expect(ctx.api.state().get("dirty") is True, "tab lost dirty state after jump")
                txt = (ctx.api.editor_text_get() or {}).get("text") or ""
                ctx.expect(DIRTY in txt, f"buffer content changed after jump: {txt!r}")

            with ctx.step("Folder-Draft via Kontextmenue → scoped Submit"):
                td_norm = td.replace("\\", "/")
                sub_norm = td_norm + "/sub"
                sub_sel = '#vault-tree li.node[data-path="%s"]' % sub_norm
                # Pin-Ordner aufklappen, bis der Unterordner sichtbar ist.
                # (Suche verlassen, damit der Baum sichtbar ist.)
                ctx.api.eval(
                    "document.getElementById('vault-search-list')"
                    ".dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
                )
                _poll(
                    ctx,
                    lambda: _evalv(
                        ctx,
                        "getComputedStyle(document.getElementById('vault-tree')).display!=='none'",
                    ),
                )
                ctx.api.click('#vault-tree li.node[data-path="%s"] > .row' % td_norm)
                appeared = _poll(
                    ctx, lambda: _evalv(ctx, "!!document.querySelector(%s)" % json.dumps(sub_sel))
                )
                ctx.expect(appeared is True, "sub-Ordner nicht im Baum aufgetaucht")
                # Rechtsklick → „In diesem Ordner suchen" oeffnet den Dialog mit Folder-Draft.
                ctx.api.right_click(sub_sel)
                _poll(
                    ctx,
                    lambda: _evalv(
                        ctx,
                        "!!document.querySelector('#context-menu.open .ctx-item[data-act=\\'search-folder\\']')",
                    ),
                )
                ctx.api.click("#context-menu .ctx-item[data-act=\"search-folder\"]")
                ctx.expect(_poll(ctx, lambda: _dialog_visible(ctx)) is True, "dialog not opened from context menu")
                # Folder-Option sichtbar + vorausgewaehlt.
                folder_state = _evalv(
                    ctx,
                    "(function(){var row=document.getElementById('vsd-scope-folder-row');"
                    "var r=document.querySelector('input[name=\"vsd-scope\"][value=\"folder\"]');"
                    "return{rowShown:row?!row.hidden:false,checked:r?r.checked:false};})()",
                ) or {}
                ctx.expect(folder_state.get("rowShown") is True, "folder scope row hidden")
                ctx.expect(folder_state.get("checked") is True, "folder scope not preselected")
                # Query setzen + submitten (Scope bleibt folder).
                _fill_and_submit(ctx, TOKEN, scope="folder")
                ctx.expect(_wait_dialog_closed(ctx) is True, "folder submit kept dialog open")
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

            # --- Scope „Gefilterte Dateien" (Referenzfaelle R1–R8) ----------
            # Eigener Pin `R`; die Filtermenge kommt aus dem Vault-Filter
            # (volle Treffermenge, unabhaengig vom gerenderten Baum).
            with ctx.step("Gefilterte Dateien: Fixture R pinnen, Filter setzen"):
                r_td = tempfile.mkdtemp(prefix="folio-e2e-filtered-")
                r = r_td.replace("\\", "/")
                for rel, text in (
                    ("notes/spec-a.md", "TODO alpha"),
                    ("notes/other.md", "TODO beta"),
                    (".herd/spec-b.md", "TODO gamma"),
                    ("deep/x/spec-c.txt", "TODO delta"),
                ):
                    _write(os.path.join(r_td, *rel.split("/")), text)
                ctx.api.settings_set({"vaultShowHidden": True})
                ctx.api.workspace_pin(r_td, is_directory=True)
                r_pinned = True
                if _evalv(ctx, "document.getElementById('vault-filter').hidden") is True:
                    _click_id(ctx, "vault-filter-toggle")
                for chip in ("vault-filter-md", "vault-filter-git",
                             "vault-filter-deep", "vault-filter-hidden"):
                    _toggle_chip(ctx, chip, False)
                _set_filter_query(ctx, "spec")

            with ctx.step("R1: Query spec → spec-a.md + spec-c.txt (deep/ zugeklappt)"):
                got = _filtered_names(ctx)
                ctx.expect(got == ["spec-a.md", "spec-c.txt"], f"R1: {got}")
                deep_open = _evalv(
                    ctx,
                    "(function(){var c=document.querySelector("
                    + json.dumps(f'#vault-tree li.node[data-path="{r}/deep"] > .row > .caret')
                    + ");return !!c&&c.classList.contains('open');})()",
                )
                ctx.expect(deep_open is False, "deep/ wurde aufgeklappt")
                summary = _evalv(
                    ctx, "document.getElementById('vault-search-summary-opts').textContent"
                )
                ctx.expect("\u25bd 2" in (summary or ""), f"Summary-Glyph: {summary!r}")

            with ctx.step("R2: Chip .* an → zusaetzlich .herd/spec-b.md"):
                _toggle_chip(ctx, "vault-filter-hidden", True)
                got = _filtered_names(ctx)
                ctx.expect(got == ["spec-a.md", "spec-b.md", "spec-c.txt"], f"R2: {got}")

            with ctx.step("R3: Chip .* an, vaultShowHidden aus → wie R1"):
                ctx.api.settings_set({"vaultShowHidden": False})
                got = _filtered_names(ctx)
                ctx.expect(got == ["spec-a.md", "spec-c.txt"], f"R3: {got}")
                ctx.api.settings_set({"vaultShowHidden": True})
                _toggle_chip(ctx, "vault-filter-hidden", False)

            with ctx.step("R4: Chip .md an → nur spec-a.md"):
                _toggle_chip(ctx, "vault-filter-md", True)
                got = _filtered_names(ctx)
                ctx.expect(got == ["spec-a.md"], f"R4: {got}")
                _toggle_chip(ctx, "vault-filter-md", False)

            with ctx.step("R5: Dialog-Dateityp Nur Markdown → nur spec-a.md"):
                got = _filtered_names(ctx, file_filter="markdown")
                ctx.expect(got == ["spec-a.md"], f"R5: {got}")

            with ctx.step("R6: Bereich R/deep + Query spec → nur spec-c.txt"):
                ctx.api.eval("window.__folioVaultFilterInFolder(%s)" % json.dumps(f"{r}/deep"))
                got = _filtered_names(ctx)
                ctx.expect(got == ["spec-c.txt"], f"R6: {got}")

            with ctx.step("R7: Bereich R/notes + .md, Query leer → spec-a.md + other.md"):
                ctx.api.eval("window.__folioVaultFilterInFolder(%s)" % json.dumps(f"{r}/notes"))
                _set_filter_query(ctx, "")
                _toggle_chip(ctx, "vault-filter-md", True)
                got = _filtered_names(ctx)
                ctx.expect(got == ["other.md", "spec-a.md"], f"R7: {got}")
                _toggle_chip(ctx, "vault-filter-md", False)

            with ctx.step("R8: Query s ohne Bereich → Option deaktiviert"):
                ctx.api.eval("window.__folioVaultFilterReset()")
                _set_filter_query(ctx, "s")
                ctx.expect(_open_dialog_via_summary(ctx) is True, "Dialog oeffnet nicht")
                ctx.expect(
                    _filtered_radio_disabled(ctx) is True,
                    "Option 'Gefilterte Dateien' bei 1-Zeichen-Query waehlbar",
                )
                _click_id(ctx, "vsd-cancel")

        finally:
            # Observer + evtl. offenen Dialog aufraeumen.
            try:
                ctx.api.eval(
                    "(function(){if(window.__vsMo){window.__vsMo.disconnect();window.__vsMo=null;}"
                    "var d=document.getElementById('vault-search-dialog');"
                    "if(d&&!d.hidden){var c=document.getElementById('vsd-cancel');"
                    "if(c)c.dispatchEvent(new MouseEvent('click',{bubbles:true}));}return true;})()"
                )
            except Exception:
                pass
            try:
                ctx.api.eval(
                    "typeof window.__folioVaultFilterReset==='function'"
                    "&&window.__folioVaultFilterReset()"
                )
            except Exception:
                pass
            if r_pinned:
                try:
                    ctx.api.workspace_unpin(r_td)
                except Exception:
                    pass
            if r_td:
                shutil.rmtree(r_td, ignore_errors=True)
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
