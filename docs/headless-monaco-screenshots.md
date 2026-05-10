# Visuelle Verifikation auf Headless-Linux (Monaco/Canvas-Apps)

Tauri-Apps auf Linux nutzen WebKitGTK. Sobald die Web-UI Canvas-basiert
rendert (Monaco-Editor, WebGL, manche Charting-Libs), zeigt ein
`xcap`/`scrot`-Screenshot in einer Headless-Xvfb-Sitzung den
Editor-Bereich oft **leer** — funktional läuft alles, sichtbar ist
nur die Canvas-Fläche nicht. Grund: WebKitGTK rendert Canvas über den
GPU-Compositor, dessen Output landet nicht im X11-Framebuffer, den
xcap abgreift.

Diese Notiz sammelt Wege, *trotzdem* visuelles Feedback auf einem VPS
oder in CI zu bekommen — relevant für jeden Agenten, der eine
Tauri-App ohne echten Bildschirm entwickelt oder testet.

## TL;DR

| Option | Aufwand | Zuverlässigkeit | Wo? |
|---|---|---|---|
| 1. Compositor-Env-Vars | 1 Zeile | mittel — abhängig von WebKit-Build | sofort |
| 2. Xvfb + Mesa-Software-GL | Setup einmal | hoch | VPS / CI |
| 3. WebView-eigener Snapshot | Tauri-Plugin | sehr hoch | Code-Eingriff |
| 4. xpra / TurboVNC | Setup einmal | sehr hoch | wie echtes Display |
| 5. View-Mode-Screenshot | trivial | nur HTML | Folio-spezifisch |

Pragma: erst **(1)** probieren — falls ja, ist das Thema One-Liner.
Sonst **(2)**. **(3)** ist die langfristig sauberste Lösung,
weil display-unabhängig.

## Hintergrund: warum Canvas in Headless wegfällt

WebKitGTK 2.40+ rendert standardmäßig per GPU-Compositor (DMA-BUF /
GLX). Der finale Frame landet als Texture beim Compositor, der ihn
ans Display-Subsystem weiterreicht. xcap liest nur den X11-Pixmap-
Buffer — was der Compositor woanders durchreicht, ist nicht drin.
Sichtbarer Effekt: HTML/CSS-Teile (über regular Painting) sind
da, Canvas/WebGL-Surfaces sind weg.

Auf einem echten Display zieht der Window-Manager den GPU-Output ins
X11-Pixmap zurück, weshalb es dort funktioniert — nur in Xvfb (kein
echter Compositor) bleibt der Canvas-Layer hängen.

## Option 1 — WebKit-Compositor abschalten (Software-Fallback)

Schaltet den GPU-Pfad in WebKit aus, Canvas geht über Cairo (CPU).
Pixel landen im normalen X-Framebuffer.

```bash
WEBKIT_DISABLE_COMPOSITING_MODE=1 \
WEBKIT_DISABLE_DMABUF_RENDERER=1 \
LIBGL_ALWAYS_SOFTWARE=1 \
folio
```

Test ob's wirkt:

```bash
# Xvfb starten, falls noch nicht laufend
Xvfb :99 -screen 0 1920x1080x24 &
export DISPLAY=:99

# App mit Software-Pfad
WEBKIT_DISABLE_COMPOSITING_MODE=1 LIBGL_ALWAYS_SOFTWARE=1 folio &
sleep 3

# Screenshot
curl -s http://127.0.0.1:9876/screenshot -o /tmp/test.png
```

Wenn der Editor-Bereich auf `/tmp/test.png` jetzt Text zeigt: fertig,
das ist der ganze Fix. Auf manchen WebKitGTK-Builds (z. B. ältere
2.38-er) reicht's nicht — dann Option 2.

## Option 2 — Xvfb + Mesa-Software-GL

Wenn Option 1 alleine nicht reicht: einen vollständigen GLX-fähigen
X-Stack mit Software-Mesa hochziehen. WebKit nutzt seinen GPU-Pfad,
nur eben gegen einen CPU-OpenGL.

```bash
sudo apt install -y \
    xvfb \
    libgl1-mesa-dri \
    libegl1-mesa \
    mesa-utils \
    libgles2-mesa
```

Xvfb mit GLX-Extension starten:

```bash
Xvfb :99 -screen 0 1920x1080x24 +extension GLX +render -noreset &
export DISPLAY=:99
export LIBGL_ALWAYS_SOFTWARE=1
export __GLX_VENDOR_LIBRARY_NAME=mesa

# Verifizieren, dass Software-GL läuft
glxinfo | grep -E "OpenGL renderer|direct rendering"
# erwartet: "OpenGL renderer string: llvmpipe ..." + "direct rendering: Yes"

folio &
```

Damit hat WebKit eine GLX-Pipeline, die ans X11-Display rendert →
xcap-Screenshots zeigen Canvas korrekt.

## Option 3 — Snapshot direkt aus dem WebView (sauberste Lösung)

Statt am X11-Framebuffer zu kratzen, fragen wir den Webview selbst
nach einem Snapshot — der weiß, was er gerade rendert, unabhängig vom
Compositor-Pfad. WebKitGTK exponiert `webkit_web_view_get_snapshot()`,
das eine Cairo-Surface zurückgibt.

In Tauri 2 lässt sich das in einem Plugin oder direkt über
`tauri::WebviewWindow` exposen — Beispiel-Skizze:

```rust
// src-tauri/src/automation.rs
#[tauri::command]
async fn webview_snapshot(window: tauri::WebviewWindow) -> Result<Vec<u8>, String> {
    // Im Tauri-internen Webview-Wrapper: webkit2gtk::WebView::snapshot()
    // mit SnapshotRegion::FullDocument, async via channel zurückgeben
    todo!("WebKit-spezifisch, Pseudocode — siehe webkit2gtk crate")
}
```

Bestehender Ansatz, den man nicht selbst schreiben muss:
**`tauri-plugin-screenshots`** (Community-Plugin) macht genau das,
plattformübergreifend. Im Tauri-2-Branch gepflegt.

Vorteil: funktioniert auch auf macOS/Windows-Headless (CI-Runner mit
Hidden-Window) und ignoriert Compositor-Fragen komplett. Nachteil:
Code-Eingriff, Plugin-Wartung.

## Option 4 — xpra / TurboVNC (persistente Sitzung)

Wenn der Agent über längere Zeit auf dem VPS arbeitet, lohnt eine
echte Display-Sitzung statt Xvfb-Wegwerf.

**xpra** (rootless, X11-Forwarding über HTTP/WebSocket):

```bash
sudo apt install -y xpra
xpra start :100 --bind-tcp=0.0.0.0:14500 --html=on --start=folio
# Browser öffnen: http://<vps>:14500
```

Der Agent startet die App in der xpra-Sitzung, du verbindest dich
parallel und siehst, was passiert. xpra hat einen eingebauten
Software-Compositor — Canvas funktioniert.

**TurboVNC** ist die High-Performance-Variante mit VirtualGL, falls
auf dem VPS GPU-Hardware verfügbar ist (selten).

## Option 5 — View-Mode-Screenshot (Folio-spezifisch)

Folios View-Mode rendert reines HTML+CSS über `comrak`, kein Canvas.
Screenshots davon klappen auf jedem Headless-Setup ohne Tricks.
Reicht für:

- Theme-Verifikation (Hell/Dunkel)
- Toolbar/Statusbar/Menü-Layout
- TOC-Rail-Inhalt
- gerenderte Markdown-Ausgabe

Vorgehen:

```bash
curl -X POST http://127.0.0.1:9876/mode -d '{"mode":"view"}'
curl http://127.0.0.1:9876/screenshot -o view.png
```

Was *nicht* geht im View-Mode: Edit-spezifische UI (Cheat-Sheet,
Edit-Toolbar, Monaco selbst). Für die braucht's einen der
oberen Wege.

## Empfehlung pro Use-Case

- **CI-Run für PR-Check**: Option 2 (Xvfb + Mesa-Software-GL).
  Reproducible, keine Plugin-Pflege, läuft in jedem Container.
- **Agent auf VPS, schnelle Iteration**: Option 1 zuerst probieren,
  bei Bedarf Option 4 für visuelle Co-Inspektion.
- **Langfristig display-unabhängig**: Option 3 als Tauri-Plugin
  pflegen — einmal Setup, gilt für alle Plattformen und Targets.
- **Folio-spezifische Layouts/Themes**: Option 5 reicht, ist trivial.

## Beobachtetes Verhalten Folio (Stand 2026-05)

Auf Ralfs Laptop (X11, Cinnamon, Mint-Y-Theme, `DISPLAY=:0`):
Monaco-Canvas-Output ist im `xcap`-Screenshot vollständig sichtbar
inklusive Syntax-Highlighting — Compositor zieht sauber durch. Kein
Workaround nötig.

Auf Headless-VPS / Xvfb-CI (noch nicht systematisch getestet):
Status offen. Wenn Tests laufen, hier ergänzen welche der Optionen
zuverlässig war und welche WebKitGTK-Version zum Einsatz kam
(`webkit2gtk-4.1` vs. `4.0` macht beim DMA-BUF-Renderer einen
Unterschied).
