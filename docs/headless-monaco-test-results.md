# Testergebnisse: Headless-Monaco-Screenshots

**Datum:** 2026-05-09
**Tester:** Hermes Agent (kimi-k2.6)
**Umgebung:**
- OS: Ubuntu 24.04 (noble)
- webkit2gtk-4.1: 2.52.3-0ubuntu0.24.04.1
- Mesa: 25.2.8-0ubuntu0.24.04.1
- Xvfb: 2:21.1.12-1ubuntu1.5
- xcap: via Tauri Automation API (interne `/screenshot` Route)
- ImageMagick: `import -window root`

**App-Version:** Folio `main` Branch (post-Monaco-Merge, Commit `b6a0996`)

---

## Ziel

Die in [`docs/headless-monaco-screenshots.md`](headless-monaco-screenshots.md) beschriebenen Optionen systematisch testen und dokumentieren, ob Monaco in einer Headless-Umgebung (VPS ohne physischen Bildschirm) visuell screenshotbar ist.

---

## Testmethodik

Für jede Option wurde folgendes Protokoll durchlaufen:

1. X-Server (Xvfb oder xpra) starten
2. Folio-App starten (mit ggf. spezifischen Env-Vars)
3. Auf Automation API (`127.0.0.1:9876`) warten
4. Edit-Modus aktivieren (`POST /mode {"mode":"edit"}`)
5. Editor-Text setzen (`POST /editor/text`)
6. State prüfen (`GET /state` → `editor.ready`)
7. Screenshot via ImageMagick (`import -window root`)
8. Screenshot via interner API (`GET /screenshot` → `xcap`)
9. Visuelle Prüfung des Center-Bereichs (Vision-Tool)

---

## Ergebnisse

### Option 1: WebKit-Compositor Env-Vars

**Befehl:**
```bash
WEBKIT_DISABLE_COMPOSITING_MODE=1 \
WEBKIT_DISABLE_DMABUF_RENDERER=1 \
LIBGL_ALWAYS_SOFTWARE=1 \
folio
```

**Ergebnis:**
- `editor.ready`: `True` ✅
- ImageMagick-Screenshot: Center-Bereich **komplett weiß** ❌
- xcap `/screenshot`: `{"error":"_NET_CLIENT_LIST_STACKING not supported"}` ❌

**Interpretation:** Die Env-Vars schalten den GPU-Compositor ab, aber WebKitGTK rendert Canvas trotzdem nicht in den X11-Framebuffer, den ImageMagick abgreift. xcap scheitert am fehlenden Window Manager in Xvfb.

---

### Option 2: Xvfb + Mesa-Software-GL

**Befehl:**
```bash
Xvfb :99 -screen 0 1280x720x24 +extension GLX +render -noreset -ac
export DISPLAY=:99
export LIBGL_ALWAYS_SOFTWARE=1
export __GLX_VENDOR_LIBRARY_NAME=mesa
```

**GLX-Verifikation:**
```
OpenGL renderer string: llvmpipe (LLVM 20.1.2, 256 bits)
direct rendering: Yes
```

**Ergebnis:**
- `editor.ready`: `True` ✅
- ImageMagick-Screenshot: Center-Bereich **komplett weiß** ❌
- xcap `/screenshot`: `{"error":"_NET_CLIENT_LIST_STACKING not supported"}` ❌

**Interpretation:** Obwohl llvmpipe als Software-Renderer läuft und direct rendering aktiv ist, landet der Monaco-Canvas-Output nicht im X11-Pixmap-Buffer. xcap scheitert weiterhin am fehlenden `_NET_CLIENT_LIST_STACKING` (kein WM in Xvfb).

---

### Option 4: xpra (persistente Sitzung)

**Befehl:**
```bash
xpra start :100 --no-daemon
DISPLAY=:100 ./src-tauri/target/release/folio
```

**Ergebnis:**
- App-Prozess läuft ✅
- `editor.ready`: `False` ❌
- ImageMagick-Screenshot: **Komplett weiß** (nicht mal UI-Elemente sichtbar) ❌
- xpra `screenshot`-Befehl: Fehler bei Socket-Verbindung ❌

**Interpretation:** Monaco initialisiert sich in xpra-Sitzungen nicht korrekt (`editor.ready: False`). Der Screenshot zeigt gar keine App-Oberfläche, was darauf hindeutet, dass xpra's interne Compositor-Architektur nicht mit WebKitGTK's Rendering-Pfad kompatibel ist.

---

### Option 5: View-Mode-Screenshot (Folio-spezifisch)

**Befehl:**
```bash
Xvfb :99 -screen 0 1280x720x24 -ac
curl -X POST http://127.0.0.1:9876/open -d '{"path":"/path/to/index.md"}'
curl -X POST http://127.0.0.1:9876/mode -d '{"mode":"view"}'
import -window root /tmp/viewmode.png
```

**Ergebnis:**
- `viewMode`: `view` ✅
- TOC: 7 Einträge korrekt extrahiert ✅
- ImageMagick-Screenshot: **Vollständig gerendertes Markdown sichtbar** ✅
  - H1, H2, Listen, Links, Code-Blocks, Inline-Formatierung, Blockquotes

**Interpretation:** View-Mode rendert über `comrak` reines HTML+CSS (kein Canvas). Das funktioniert in jeder Headless-Umgebung ohne Workarounds.

---

## Zusammenfassung

| Option | `editor.ready` | Monaco sichtbar | Screenshot-Methode | Bewertung |
|---|---|---|---|---|
| 1. Env-Vars | ✅ True | ❌ Nein | ImageMagick / xcap | Funktional OK, visuell nicht verifizierbar |
| 2. Xvfb + Mesa-GL | ✅ True | ❌ Nein | ImageMagick / xcap | Gleiches Problem wie Option 1 |
| 4. xpra | ❌ False | ❌ Nein | ImageMagick / xpra | Monaco initialisiert sich gar nicht |
| 5. View-Mode | N/A (kein Editor) | ✅ HTML+CSS | ImageMagick | **Einzige funktionierende Option** |

---

## Fazit

**Keine der getesteten Optionen ermöglicht einen visuell korrekten Screenshot des Monaco-Editors in einer Headless-Umgebung.**

- Option 1 und 2 zeigen, dass selbst mit Software-Rendering der Canvas-Output von WebKitGTK nicht in den X11-Framebuffer gelangt, den externe Tools abgreifen.
- Option 4 (xpra) ist inkompatibel mit Monaco's Initialisierung.
- **Option 5 (View-Mode) ist der einzige zuverlässige Weg**, visuelles Feedback in Headless-Umgebungen zu bekommen – allerdings nur für gerendertes Markdown, nicht für den Editor selbst.

**Empfehlung für CI/Agent-Tests:**
- Funktionale Tests (Text-API, TOC, State) laufen in Headless-Umgebungen einwandfrei.
- Visuelle Verifikation des Monaco-Editors erfordert einen **echten Bildschirm** (`DISPLAY=:0` o. ä.) oder einen VNC-Server mit Hardware-Compositor.
- Für Layout-/Theme-Tests in CI: **View-Mode-Screenshots** verwenden.

---

## Offene Punkte

- Option 3 (WebView-eigener Snapshot via `tauri-plugin-screenshots`) wurde nicht getestet, da sie Code-Änderungen am Projekt erfordert.
- Ein Test auf echtem Display (`DISPLAY=:0`) wurde nicht durchgeführt, da der VPS keinen physischen Bildschirm hat.
