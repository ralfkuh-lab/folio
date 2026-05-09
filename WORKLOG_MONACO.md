# Worklog: Monaco Editor Integration

**Branch:** `monaco`
**Ziel:** CodeMirror 6 durch Monaco Editor ersetzen, API- und UI-Kompatibilität beibehalten.

---

## Plan

### Phase 0 — Setup
- [ ] `monaco-editor` als npm-Dependency hinzufügen
- [ ] Build-Script anpassen (Monaco-Dateien kopieren + Wrapper bündeln)
- [ ] Ersten Commit

### Phase 1 — Monaco-Wrapper
- [ ] Neuer `editor.ts`: async Monaco-Laden via `loader.js`
- [ ] `window.FolioEditor.*` API kompatibel halten (mount, setText, getText, getSelection, applyReplace, focus, setTheme)
- [ ] Find-Decorations mit Monaco `IModelDeltaDecoration` statt CodeMirror `DecorationSet`
- [ ] Marker-Lane beibehalten (findet Match-Positionen aus Modell)
- [ ] Events: `editorReady`, `editorTextChanged`, `editorSelection`, `editorFindState`, `editorSaveRequested`
- [ ] Markdown-Syntax-Highlighting in Monaco aktivieren

### Phase 2 — HTML-Anpassungen
- [ ] `index.html`: Monaco-Loader (`monaco/loader.js`) statt direktem Bundle laden
- [ ] `ensureEditorMounted` / `loadEditorText` async machen
- [ ] CSS: `.cm-editor` → `.monaco-editor` Container-Styles
- [ ] Theme-Synchronisation Light/Dark

### Phase 3 — Cleanup
- [ ] CodeMirror-Abhängigkeiten aus `package.json` entfernen
- [ ] Altes `editor.bundle.js` entfernen
- [ ] `cargo test` erfolgreich
- [ ] `cargo build` erfolgreich
- [ ] `cargo tauri build --bundles deb` erfolgreich

### Phase 4 — Finale
- [ ] README/CLAUDE.md aktualisieren
- [ ] Worklog abschließen
- [ ] Finaler Commit

---

## Fortschritt

| Phase | Schritt | Status | Commit |
|-------|---------|--------|--------|
| 0 | Setup & Dependencies | ✅ done | `5621341` → `monaco-setup` |
| 1 | Monaco-Wrapper `editor.ts` | ✅ done | `monaco-setup` → ... |
| 2 | `index.html` Anpassungen | ✅ done | `5ad6ce1` → ... |
| 3 | Cleanup & Tests | 🔄 in progress | — |
| 4 | Finale & Dokumentation | ⏳ pending | — |

---

## Notizen

- Monaco-Worker in Tauri-WebView: via `MonacoEnvironment.getWorkerUrl` mit Blob-URLs oder lokale Pfade.
- `dist/` darf laut CLAUDE.md keine npm-Artefakte enthalten — Monaco-Dateien sind reine JS/CSS, keine `package.json`.
- Find-Logik: eigene HTML-Find-Bar bleibt, Monaco-eigenes Find-Widget wird über Keybindings deaktiviert.
