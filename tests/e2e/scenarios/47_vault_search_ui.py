"""UI-Test fuer die Vault-Volltextsuche im Such-/Filterbereich (S9).

Der Funnel im Vault-Kopf oeffnet EINEN Bereich: Namensfilter oben,
Inhaltsfeld `#vault-search-input` darunter (Enter sucht sofort, Umschalter
Aa/ab/Rx, Zahnrad-Popover). Die Suche durchsucht, was der Filter zeigt —
ohne Filter den ganzen Vault.

Deckt ab:
- Strg+Shift+F oeffnet den Bereich und fokussiert das Inhaltsfeld; Enter
  sucht, Ergebnis-Rendering (<mark>, Gruppen), Baum + Tags im Suchmodus weg,
  Statuszusatz „· Vault"/„· gefiltert".
- Funnel zu beendet die Suche, Wiederoeffnen zeigt den Begriff, Enter
  wiederholt (F10); Validierungsfehler am Feld ohne Lauf (F9).
- Regex-Lauf (Rx) inkl. View-Mode-Sprung (Jump.term = gematchter Text).
- Auto-Collapse ab >10 Treffergruppen; Collapse-All/Expand-All.
- Spinner (`vs-running`): waehrend eines Laufs gesetzt, danach entfernt.
- Kontextmenue „In diesem Ordner suchen" → Bereich + Fokus Inhaltsfeld (F11);
  Bereich-✕ sucht automatisch vault-weit neu.
- Zahnrad-Popover: Fokus beim Oeffnen, Escape schliesst und gibt den Fokus
  ans Zahnrad zurueck, ohne die Suche zu beenden.
- Suchraum-Referenzfaelle F1–F6 und F8 (automatisches Neu-Suchen nach
  Filteraenderung).

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


def _field_value(ctx):
    return _evalv(ctx, "document.getElementById('vault-search-input').value")


def _searching(ctx):
    return _evalv(
        ctx, "document.getElementById('vault-region').classList.contains('vault-searching')"
    ) is True


def _open_area(ctx):
    """Bereich ueber den Funnel oeffnen (falls zu)."""
    if _evalv(ctx, "document.getElementById('vault-filter').hidden") is True:
        _click_id(ctx, "vault-filter-toggle")
    ctx.expect(
        _poll(ctx, lambda: _evalv(ctx, "document.getElementById('vault-filter').hidden") is False)
        is True,
        "Such-/Filterbereich nicht offen",
    )


def _set_toggle(ctx, el_id, on):
    pressed = _evalv(
        ctx, "document.getElementById(%s).getAttribute('aria-pressed')" % json.dumps(el_id)
    ) == "true"
    if pressed != on:
        _click_id(ctx, el_id)


def _search(ctx, query):
    """Inhaltsfeld fuellen + Enter (wie der Nutzer). Der Status wird vorher
    geleert, damit das Ende genau dieses Laufs erkennbar ist."""
    ctx.api.eval(
        "(function(){var s=document.getElementById('vault-search-status');s.textContent='';"
        "var i=document.getElementById('vault-search-input');i.value=%s;"
        "i.dispatchEvent(new Event('input',{bubbles:true}));"
        "i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));"
        "return true;})()" % json.dumps(query)
    )


def _wait_done(ctx):
    def done():
        st = _evalv(
            ctx,
            "(function(){var s=document.getElementById('vault-search-status');"
            "return {text:s.textContent,running:s.classList.contains('vs-running')};})()",
        )
        return st if (st and st.get("text") and not st.get("running")) else None

    st = _poll(ctx, done)
    ctx.expect(bool(st), "Suchlauf wurde nicht fertig")
    return (st or {}).get("text") or ""


def _clear_field(ctx):
    """Escape im Inhaltsfeld mit Text: leeren + Suche beenden."""
    ctx.api.eval(
        "document.getElementById('vault-search-input')"
        ".dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    )
    ctx.expect(_poll(ctx, lambda: not _searching(ctx)) is True, "Suche nicht beendet")


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


def _names_under(ctx, root):
    """Dateinamen der Treffergruppen unterhalb `root` (andere Pins des
    Testlaufs koennen ebenfalls `TODO` enthalten)."""
    paths = _evalv(
        ctx,
        "Array.from(document.querySelectorAll('#vault-search-list .vs-group-head'))"
        ".map(function(e){return e.title;})",
    ) or []
    prefix = root.rstrip("/") + "/"
    return sorted(p[len(prefix):].split("/")[-1] for p in paths if p.startswith(prefix))


def _case(ctx, root, query="TODO"):
    _search(ctx, query)
    status = _wait_done(ctx)
    return _names_under(ctx, root), status


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

            with ctx.step("Strg+Shift+F oeffnet den Bereich, Fokus im Inhaltsfeld"):
                ctx.api.key("F", {"ctrl": True, "shift": True})
                ctx.expect(
                    _poll(ctx, lambda: _evalv(ctx, "document.getElementById('vault-filter').hidden") is False)
                    is True,
                    "Bereich nicht durch Ctrl+Shift+F geoeffnet",
                )
                focused = _evalv(
                    ctx, "document.activeElement && document.activeElement.id"
                )
                ctx.expect(focused == "vault-search-input", f"Inhaltsfeld nicht fokussiert: {focused}")

            with ctx.step("Enter (Vault, allText) → 3 Gruppen mit <mark>"):
                _search(ctx, TOKEN)
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
                status = _wait_done(ctx)
                ctx.expect("· Vault" in status, f"Statuszusatz fehlt: {status!r}")
                info = _evalv(
                    ctx,
                    "(function(){var gs=document.querySelectorAll('#vault-search-list .vs-group');"
                    "var g=null;for(var i=0;i<gs.length;i++){if(gs[i].querySelector('.vs-fname').textContent==='notes.md')g=gs[i];}"
                    "var mark=g.querySelector('.vs-snippet mark');"
                    "var line=g.querySelector('.vs-line');"
                    "var treeHidden=getComputedStyle(document.getElementById('vault-tree')).display==='none';"
                    "var tagsHidden=getComputedStyle(document.getElementById('vault-tags-section')).display==='none';"
                    "return {mark:mark?mark.textContent:null,line:line?line.textContent:null,treeHidden:treeHidden,tagsHidden:tagsHidden};})()",
                )
                ctx.expect(info.get("treeHidden") is True, "tree must be hidden while searching")
                ctx.expect(info.get("tagsHidden") is True, "Tags-Sektion muss im Suchmodus weg sein")
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

            with ctx.step("Funnel zu beendet die Suche; Wiederoeffnen + Enter wiederholt (F10)"):
                groups_before = _count(ctx, "#vault-search-list .vs-group")
                _click_id(ctx, "vault-filter-toggle")
                ctx.expect(_poll(ctx, lambda: not _searching(ctx)) is True, "Suche lief nach Funnel-zu weiter")
                tree_back = _evalv(
                    ctx, "getComputedStyle(document.getElementById('vault-tree')).display!=='none'"
                )
                ctx.expect(tree_back is True, "Baum nach Funnel-zu nicht sichtbar")
                _open_area(ctx)
                ctx.expect(_field_value(ctx) == TOKEN, f"Begriff verloren: {_field_value(ctx)!r}")
                _search(ctx, TOKEN)
                _wait_done(ctx)
                ctx.expect(
                    _poll(ctx, lambda: _count(ctx, "#vault-search-list .vs-group") == groups_before)
                    is True,
                    "Wiederholte Suche liefert andere Gruppen",
                )

            with ctx.step("Validierung: 1 Zeichen + Enter → Fehler am Feld, kein Lauf (F9)"):
                _search(ctx, "Z")
                err = _poll(
                    ctx,
                    lambda: _evalv(
                        ctx,
                        "(function(){var e=document.getElementById('vault-search-error');"
                        "return e&&!e.hidden?e.textContent:null;})()",
                    ),
                )
                ctx.expect(bool(err), "Validierungsfehler nicht sichtbar")
                ctx.expect(
                    _evalv(ctx, "document.getElementById('vault-search-input').getAttribute('aria-invalid')")
                    == "true",
                    "aria-invalid fehlt",
                )

            with ctx.step("Auto-Collapse ab >10 Gruppen + Spinner-Beleg"):
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
                _search(ctx, MANY)
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
                # Rx am Feld an (bei aktiver Suche sucht der Wechsel sofort neu —
                # das folgende Enter ueberholt diesen Lauf).
                _set_toggle(ctx, "vault-search-regex", True)
                # Pattern matcht das TOKEN literal (ZQXKN), aber ueber Regex.
                _search(ctx, "ZQ.KN")
                got = _poll(ctx, lambda: _group_hits(ctx, "notes.md") == 3)
                ctx.expect(got is True, f"regex notes hits={_group_hits(ctx, 'notes.md')}")
                word_disabled = _evalv(ctx, "document.getElementById('vault-search-word').disabled")
                ctx.expect(word_disabled is True, "'ab' bei aktivem Rx nicht deaktiviert")
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
                _set_toggle(ctx, "vault-search-regex", False)

            with ctx.step("Kontextmenue In-diesem-Ordner-suchen → Bereich + Fokus, Enter (F11)"):
                td_norm = td.replace("\\", "/")
                sub_norm = td_norm + "/sub"
                sub_sel = '#vault-tree li.node[data-path="%s"]' % sub_norm
                # Suche verlassen (Escape im Feld leert es), damit der Baum sichtbar ist.
                _clear_field(ctx)
                ctx.api.click('#vault-tree li.node[data-path="%s"] > .row' % td_norm)
                appeared = _poll(
                    ctx, lambda: _evalv(ctx, "!!document.querySelector(%s)" % json.dumps(sub_sel))
                )
                ctx.expect(appeared is True, "sub-Ordner nicht im Baum aufgetaucht")
                ctx.api.right_click(sub_sel)
                _poll(
                    ctx,
                    lambda: _evalv(
                        ctx,
                        "!!document.querySelector('#context-menu.open .ctx-item[data-act=\\'search-folder\\']')",
                    ),
                )
                ctx.api.click("#context-menu .ctx-item[data-act=\"search-folder\"]")
                state = _poll(
                    ctx,
                    lambda: _evalv(
                        ctx,
                        "(function(){var sc=document.getElementById('vault-filter-scope');"
                        "var n=document.getElementById('vault-filter-scope-name');"
                        "if(!sc||sc.hidden)return null;"
                        "return {name:n.textContent,focus:document.activeElement&&document.activeElement.id};})()",
                    ),
                ) or {}
                ctx.expect(state.get("name") == "sub", f"Bereich nicht gesetzt: {state}")
                ctx.expect(state.get("focus") == "vault-search-input", f"Fokus: {state}")
                _search(ctx, TOKEN)
                scoped = _poll(
                    ctx,
                    lambda: _group_hits(ctx, "inner.md") == 1
                    and _group_hits(ctx, "notes.md") == -1
                    and _group_hits(ctx, "more.md") == -1,
                )
                ctx.expect(
                    scoped is True,
                    f"scope inner={_group_hits(ctx, 'inner.md')} "
                    f"notes={_group_hits(ctx, 'notes.md')} more={_group_hits(ctx, 'more.md')}",
                )
                status = _wait_done(ctx)
                ctx.expect("· gefiltert" in status, f"Statuszusatz: {status!r}")

            ctx.screenshot("47_folder_scope")

            with ctx.step("Bereich-✕ → automatisch wieder vault-weit (ohne Enter)"):
                _click_id(ctx, "vault-filter-scope-remove")
                widened = _poll(
                    ctx,
                    lambda: _group_hits(ctx, "notes.md") == 3
                    and _group_hits(ctx, "inner.md") == 1,
                )
                ctx.expect(
                    widened is True,
                    f"nach Bereich-✕ notes.md={_group_hits(ctx, 'notes.md')} "
                    f"inner.md={_group_hits(ctx, 'inner.md')}",
                )

            with ctx.step("Zahnrad-Popover: oeffnen, Fokus, Escape gibt Fokus ans Zahnrad"):
                ctx.api.eval("document.getElementById('vault-search-options-toggle').click()")
                st = _poll(
                    ctx,
                    lambda: _evalv(
                        ctx,
                        "(function(){var p=document.getElementById('vault-search-options');"
                        "if(!p.matches(':popover-open'))return null;"
                        "return {exp:document.getElementById('vault-search-options-toggle').getAttribute('aria-expanded'),"
                        "focus:document.activeElement&&document.activeElement.id};})()",
                    ),
                ) or {}
                ctx.expect(st.get("exp") == "true", f"aria-expanded: {st}")
                ctx.expect(st.get("focus") == "vault-search-include-ignored", f"Fokus: {st}")
                ctx.api.eval(
                    "document.getElementById('vault-search-include-ignored')"
                    ".dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
                )
                closed = _poll(
                    ctx,
                    lambda: _evalv(
                        ctx,
                        "(function(){var p=document.getElementById('vault-search-options');"
                        "if(p.matches(':popover-open'))return null;"
                        "return {focus:document.activeElement&&document.activeElement.id,"
                        "searching:document.getElementById('vault-region').classList.contains('vault-searching')};})()",
                    ),
                ) or {}
                ctx.expect(closed.get("focus") == "vault-search-options-toggle", f"Fokus: {closed}")
                ctx.expect(closed.get("searching") is True, "Escape im Popover beendete die Suche")
                _clear_field(ctx)

            # --- Suchraum aus dem Filter (Referenzfaelle F1–F6, F8) ------------
            # Eigener Pin `R`; andere Pins koennen ebenfalls `TODO` enthalten,
            # deshalb zaehlen nur Treffer unterhalb von R.
            with ctx.step("Suchraum: Fixture R pinnen, Filter auf Defaults"):
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
                _open_area(ctx)
                for chip in ("vault-filter-md", "vault-filter-git",
                             "vault-filter-deep", "vault-filter-hidden"):
                    _toggle_chip(ctx, chip, False)
                _set_filter_query(ctx, "")

            with ctx.step("F1: kein Filter → Vault-Walk ohne .herd/, Status „· Vault\""):
                got, status = _case(ctx, r)
                ctx.expect(got == ["other.md", "spec-a.md", "spec-c.txt"], f"F1: {got}")
                ctx.expect("· Vault" in status, f"F1 Status: {status!r}")

            with ctx.step("F8: Name spec tippen → automatisch neu gesucht (ohne Enter)"):
                ctx.api.eval("document.getElementById('vault-search-status').textContent=''")
                _set_filter_query(ctx, "spec")
                status = _wait_done(ctx)
                got = _names_under(ctx, r)
                ctx.expect(got == ["spec-a.md", "spec-c.txt"], f"F8/F5: {got}")
                ctx.expect("· gefiltert" in status, f"F8 Status: {status!r}")

            with ctx.step("F6: Name spec + .md → nur spec-a.md"):
                _toggle_chip(ctx, "vault-filter-md", True)
                got, _ = _case(ctx, r)
                ctx.expect(got == ["spec-a.md"], f"F6: {got}")
                _toggle_chip(ctx, "vault-filter-md", False)
                _set_filter_query(ctx, "")

            with ctx.step("F2: Chip .* an → alle vier"):
                _toggle_chip(ctx, "vault-filter-hidden", True)
                got, _ = _case(ctx, r)
                ctx.expect(got == ["other.md", "spec-a.md", "spec-b.md", "spec-c.txt"], f"F2: {got}")
                _toggle_chip(ctx, "vault-filter-hidden", False)

            with ctx.step("F3: Chip .md an → Walk mit markdown"):
                _toggle_chip(ctx, "vault-filter-md", True)
                got, _ = _case(ctx, r)
                ctx.expect(got == ["other.md", "spec-a.md"], f"F3: {got}")
                _toggle_chip(ctx, "vault-filter-md", False)

            with ctx.step("F4: Bereich R/deep ohne Name → spec-c.txt, „· gefiltert\""):
                ctx.api.eval("window.__folioVaultFilterInFolder(%s)" % json.dumps(f"{r}/deep"))
                got, status = _case(ctx, r)
                ctx.expect(got == ["spec-c.txt"], f"F4: {got}")
                ctx.expect("· gefiltert" in status, f"F4 Status: {status!r}")
                _clear_field(ctx)

        finally:
            # Observer aufraeumen.
            try:
                ctx.api.eval(
                    "(function(){if(window.__vsMo){window.__vsMo.disconnect();window.__vsMo=null;}"
                    "return true;})()"
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
