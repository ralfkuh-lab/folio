---
title: Large Markdown Test Document
author: Folio Test Suite
created: 2026-04-30
tags: [test, markdown, performance, large-document]
description: Big mixed-content document zum Stresstest fuer Editor, Renderer und Save-Pipeline.
---

# Large Markdown Test Document

Dieses Dokument dient als Stress- und Regressionstest fuer Folio. Es enthaelt
gemischten Markdown-Content (Headings, Listen, Tabellen, Codebloecke, Zitate,
Links, Bilder als Referenz, Task-Listen) sowie genuegend Volumen, damit beide
Pfade abgedeckt sind:

- der **PostMessage-Bridge-Pfad** fuer grosse Editor-Payloads (das Bug-A-Szenario,
  bei dem `ExecuteScriptAsync` den inline-Skript-String beim Toolbar-Klick
  truncated hat),
- der **Line-Ending-Pfad** beim Save (Bug B: CodeMirror normalisiert intern
  CRLF zu LF; ohne Round-Trip-Konversion in `DocumentStore` wuerden bei jedem
  Save Bytes verloren gehen).

Die Datei ist absichtlich mit Windows-Zeilenenden gespeichert. Smoketest:
View-Modus oeffnen, Ctrl+2 fuer Edit, eine kleine Aenderung machen, Ctrl+S,
Bytezahl auf der Platte vergleichen — sie muss um genau die Anzahl
eingefuegter Zeichen wachsen.

## Inhaltsverzeichnis

1. [Typografie](#typografie)
2. [Listen](#listen)
3. [Codebloecke](#codeblocks)
4. [Tabellen](#tabellen)
5. [Blockzitate](#blockzitate)
6. [Task-Listen](#task-listen)
7. [Verschiedenes](#verschiedenes)
8. [Aufgaben-Sammlung](#aufgaben-sammlung)
9. [Notizen-Pool](#notizen-pool)

## Typografie

**Fett**, *Kursiv*, ~~Durchgestrichen~~, `inline-code`, [Link](https://example.com).
Kombinationen wie ***fett-kursiv*** oder `code mit **fett** drin` (das **fett** wird hier
nicht weiter ausgewertet, weil Markdig in `code` keine Inline-Formatierung mehr ausfuehrt).

Eine Auswahl typografischer Sonderzeichen, die UTF-8-Encoding und Round-Trip
ueber den Bridge-Channel ueberleben muessen: Anfuehrungszeichen oben "doppelt"
und 'einfach', Halbgeviertstrich -, Geviertstrich --, Auslassungspunkte ...,
Pfeile -> und =>, Mathe +-, *, /, ueblich Akzente: ae, oe, ue Umlaute, Esszett ss.

## Listen

- Apfel
- Birne
- Kirsche
  - Sauerkirsche
  - Suesskirsche
    - Knorpelkirsche
    - Herzkirsche
- Datteln

1. Erste Aufgabe
2. Zweite Aufgabe
   1. Unteraufgabe
   2. Noch eine Unteraufgabe
3. Dritte Aufgabe

## Codeblocks

```csharp
public sealed class DocumentStore : IDisposable
{
    public string? Path { get; private set; }
    public string Text { get; private set; } = string.Empty;
    public bool IsDirty { get; private set; }

    private string _lineEnding = "\n";
    private bool _hadBom;

    public void Load(string absolutePath)
    {
        Path = absolutePath;
        var bytes = File.ReadAllBytes(absolutePath);
        _hadBom = bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF;
        var off = _hadBom ? 3 : 0;
        var raw = Encoding.UTF8.GetString(bytes, off, bytes.Length - off);
        _lineEnding = raw.Contains("\r\n") ? "\r\n" : "\n";
        Text = _lineEnding == "\r\n" ? raw.Replace("\r\n", "\n") : raw;
    }
}
```

```javascript
window.applyEditorReplace = function (fullText, selectionStart, selectionLength) {
    if (!window.FolioEditor) return;
    window.FolioEditor.applyReplace({
        fullText: fullText || '',
        selectionStart: selectionStart || 0,
        selectionLength: selectionLength || 0,
    });
};
```

```bash
cd src/Folio/web && npm run build
cd ../../.. && dotnet test
dotnet run --project src/Folio -- test-docs/large-document.md
```

## Tabellen

| Modus | Shortcut | Status |
|-------|----------|--------|
| View  | Ctrl+1   | aktiv  |
| Edit  | Ctrl+2   | aktiv  |
| Split | Ctrl+3   | Phase 4 |

| Bug | Mechanismus | Fix |
|-----|-------------|-----|
| A — Datenverlust beim Save | ExecuteScriptAsync truncated den Skript-String bei grossen Payloads, JS dispatchte mit insert undefined, Editor-Doc wurde leer, Echo schrieb leeren String in den Store | WebViewBridge.PostJson via PostWebMessageAsJson fuer grosse strukturierte Payloads |
| B — Line-Ending-Verlust | CodeMirror normalisiert intern CRLF zu LF, Save schrieb LF-only zurueck, Datei schrumpft pro Save um die Anzahl CRLF-Sequenzen | DocumentStore haelt Original-Line-Ending und BOM und stellt sie beim Save byte-genau wieder her |

## Blockzitate

> "We can solve any problem by introducing an extra level of indirection."
>
> -- David Wheeler

> Mehrzeiliges Zitat
> mit Fortsetzung
> ueber drei Zeilen.

## Task-Listen

- [x] Editor in WebView statt WPF-Popup
- [x] Bug A: PostMessage statt ExecuteScriptAsync fuer grosse Payloads
- [x] Bug B: Line-Ending-Preservation in DocumentStore
- [x] Tests fuer CRLF/LF/BOM
- [ ] Phase 4: Split-Modus mit Live-Preview
- [ ] Image-Paste aus Clipboard
- [ ] Tabs fuer mehrere Dokumente
- [ ] Vault-Volltextsuche

## Verschiedenes

Horizontale Linie:

---

Verschachtelte Strukturen (List in Quote):

> 1. Ersten Punkt erfassen
> 2. Validieren
>    - Sanity-Check
>    - Performance-Check
> 3. Persistieren

Linkliste fuer manuellen Klicktest:

- Externer Link: [GitHub](https://github.com/anthropics/claude-code)
- Lokaler Marker: [Tabellen](#tabellen)
- Pseudo-relative Datei: [index.md](./index.md)

## Aufgaben-Sammlung

Diese Sammlung simuliert den Use-Case eines Engineers, der eine groessere
Bearbeitungs-Session in einem einzelnen Markdown-File durchfuehrt — viele
strukturierte Eintraege mit konsistentem Format. Genau das hat Bug A
ausgeloest, weil ein Toolbar-Befehl bei einer ueber 150 KB grossen Datei
den ExecuteScriptAsync-Skriptstring gesprengt hat.

### Aufgabe 001: Find-Bar Counter aktualisieren

**Status:** in Bearbeitung
**Prioritaet:** mittel
**Erstellt:** 2026-01-01
**Verantwortlich:** Claude

#### Beschreibung

Der Counter (X/Y) muss live mit dem aktuellen Treffer und der Gesamttreffer-Zahl synchronisiert sein. SearchCursor liefert die Treffer; pro Update wird per dispatchEvent ein lokales Browser-Event ausgeloest, das die HTML-Find-Bar ohne Round-Trip ueber C# aktualisiert.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Vor dem Merge unbedingt manueller Smoke mit einer 100KB+ Datei (Bug-A-Regression-Schutz).

---

### Aufgabe 002: Theme-Sync zwischen Shell und Editor

**Status:** Review
**Prioritaet:** hoch
**Erstellt:** 2026-02-02
**Verantwortlich:** Team Folio

#### Beschreibung

Light- und Dark-Mode tauschen die App-Theme-Resources aus. Editor-Farben werden ueber CSS-Custom-Properties gesteuert; ein Compartment-Reconfigure triggert Repaint im CodeMirror, falls wir spaeter modusabhaengige Anpassungen brauchen.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Achtung: Reihenfolge der DispatchJs-Calls vs. PostMessage ist nicht garantiert symmetrisch — das gehoert in die Doku.

---

### Aufgabe 003: Marker-Lane bei Window-Resize neu rendern

**Status:** abgeschlossen
**Prioritaet:** kritisch
**Erstellt:** 2026-03-03
**Verantwortlich:** Architektur-Runde

#### Beschreibung

Beim Resize aendert sich die Editor-Hoehe und damit die Y-Positionen der Marker. Der updateListener im CodeMirror fuegt einen geometryChanged-Pfad ein, der die Marker-Lane neu zeichnet (Y proportional zur Line-Position).

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Tests: dotnet test, plus Custom-Smoke ueber die Automation-API (/state, /click, /save).

---

### Aufgabe 004: Vault-Tree expand-state persistieren

**Status:** blockiert
**Prioritaet:** niedrig
**Erstellt:** 2026-04-04
**Verantwortlich:** Ralf K.

#### Beschreibung

Der bestehende Pfad ueber ExecuteScriptAsync skaliert nicht fuer Payloads ueber rund 150 KB. WebView2 truncated den Skript-String stillschweigend, was zu einem JavaScript-Syntax-Fehler oder zu einem Aufruf mit undefined-Argumenten fuehrt. Loesung: PostMessage-Kanal nutzen, der ein eigenes IPC-Protokoll mit groesseren Payloads erlaubt.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Branch-Name: feature/<task-key>. PR mit Screenshots vom View- und Edit-Modus.

---

### Aufgabe 005: Cheat-Sheet-Drag-Position clampen

**Status:** geplant
**Prioritaet:** mittel
**Erstellt:** 2026-05-05
**Verantwortlich:** Claude

#### Beschreibung

Der Counter (X/Y) muss live mit dem aktuellen Treffer und der Gesamttreffer-Zahl synchronisiert sein. SearchCursor liefert die Treffer; pro Update wird per dispatchEvent ein lokales Browser-Event ausgeloest, das die HTML-Find-Bar ohne Round-Trip ueber C# aktualisiert.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Vor dem Merge unbedingt manueller Smoke mit einer 100KB+ Datei (Bug-A-Regression-Schutz).

---

### Aufgabe 006: TOC-Highlight bei Scroll

**Status:** in Bearbeitung
**Prioritaet:** hoch
**Erstellt:** 2026-06-06
**Verantwortlich:** Team Folio

#### Beschreibung

Light- und Dark-Mode tauschen die App-Theme-Resources aus. Editor-Farben werden ueber CSS-Custom-Properties gesteuert; ein Compartment-Reconfigure triggert Repaint im CodeMirror, falls wir spaeter modusabhaengige Anpassungen brauchen.

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Achtung: Reihenfolge der DispatchJs-Calls vs. PostMessage ist nicht garantiert symmetrisch — das gehoert in die Doku.

---

### Aufgabe 007: External-Change Save-Conflict-Prompt

**Status:** Review
**Prioritaet:** kritisch
**Erstellt:** 2026-07-07
**Verantwortlich:** Architektur-Runde

#### Beschreibung

Beim Resize aendert sich die Editor-Hoehe und damit die Y-Positionen der Marker. Der updateListener im CodeMirror fuegt einen geometryChanged-Pfad ein, der die Marker-Lane neu zeichnet (Y proportional zur Line-Position).

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Tests: dotnet test, plus Custom-Smoke ueber die Automation-API (/state, /click, /save).

---

### Aufgabe 008: Editor-Toolbar Hotkeys

**Status:** abgeschlossen
**Prioritaet:** niedrig
**Erstellt:** 2026-08-08
**Verantwortlich:** Ralf K.

#### Beschreibung

Der bestehende Pfad ueber ExecuteScriptAsync skaliert nicht fuer Payloads ueber rund 150 KB. WebView2 truncated den Skript-String stillschweigend, was zu einem JavaScript-Syntax-Fehler oder zu einem Aufruf mit undefined-Argumenten fuehrt. Loesung: PostMessage-Kanal nutzen, der ein eigenes IPC-Protokoll mit groesseren Payloads erlaubt.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Branch-Name: feature/<task-key>. PR mit Screenshots vom View- und Edit-Modus.

---

### Aufgabe 009: Markdown-Pipeline GFM-Extensions

**Status:** blockiert
**Prioritaet:** mittel
**Erstellt:** 2026-09-09
**Verantwortlich:** Claude

#### Beschreibung

Der Counter (X/Y) muss live mit dem aktuellen Treffer und der Gesamttreffer-Zahl synchronisiert sein. SearchCursor liefert die Treffer; pro Update wird per dispatchEvent ein lokales Browser-Event ausgeloest, das die HTML-Find-Bar ohne Round-Trip ueber C# aktualisiert.

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Vor dem Merge unbedingt manueller Smoke mit einer 100KB+ Datei (Bug-A-Regression-Schutz).

---

### Aufgabe 010: WebView2-Bridge-Channel registrieren

**Status:** geplant
**Prioritaet:** hoch
**Erstellt:** 2026-10-10
**Verantwortlich:** Team Folio

#### Beschreibung

Light- und Dark-Mode tauschen die App-Theme-Resources aus. Editor-Farben werden ueber CSS-Custom-Properties gesteuert; ein Compartment-Reconfigure triggert Repaint im CodeMirror, falls wir spaeter modusabhaengige Anpassungen brauchen.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Achtung: Reihenfolge der DispatchJs-Calls vs. PostMessage ist nicht garantiert symmetrisch — das gehoert in die Doku.

---

### Aufgabe 011: Find-Bar Counter aktualisieren

**Status:** in Bearbeitung
**Prioritaet:** kritisch
**Erstellt:** 2026-11-11
**Verantwortlich:** Architektur-Runde

#### Beschreibung

Beim Resize aendert sich die Editor-Hoehe und damit die Y-Positionen der Marker. Der updateListener im CodeMirror fuegt einen geometryChanged-Pfad ein, der die Marker-Lane neu zeichnet (Y proportional zur Line-Position).

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Tests: dotnet test, plus Custom-Smoke ueber die Automation-API (/state, /click, /save).

---

### Aufgabe 012: Theme-Sync zwischen Shell und Editor

**Status:** Review
**Prioritaet:** niedrig
**Erstellt:** 2026-12-12
**Verantwortlich:** Ralf K.

#### Beschreibung

Der bestehende Pfad ueber ExecuteScriptAsync skaliert nicht fuer Payloads ueber rund 150 KB. WebView2 truncated den Skript-String stillschweigend, was zu einem JavaScript-Syntax-Fehler oder zu einem Aufruf mit undefined-Argumenten fuehrt. Loesung: PostMessage-Kanal nutzen, der ein eigenes IPC-Protokoll mit groesseren Payloads erlaubt.

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Branch-Name: feature/<task-key>. PR mit Screenshots vom View- und Edit-Modus.

---

### Aufgabe 013: Marker-Lane bei Window-Resize neu rendern

**Status:** abgeschlossen
**Prioritaet:** mittel
**Erstellt:** 2026-01-13
**Verantwortlich:** Claude

#### Beschreibung

Der Counter (X/Y) muss live mit dem aktuellen Treffer und der Gesamttreffer-Zahl synchronisiert sein. SearchCursor liefert die Treffer; pro Update wird per dispatchEvent ein lokales Browser-Event ausgeloest, das die HTML-Find-Bar ohne Round-Trip ueber C# aktualisiert.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Vor dem Merge unbedingt manueller Smoke mit einer 100KB+ Datei (Bug-A-Regression-Schutz).

---

### Aufgabe 014: Vault-Tree expand-state persistieren

**Status:** blockiert
**Prioritaet:** hoch
**Erstellt:** 2026-02-14
**Verantwortlich:** Team Folio

#### Beschreibung

Light- und Dark-Mode tauschen die App-Theme-Resources aus. Editor-Farben werden ueber CSS-Custom-Properties gesteuert; ein Compartment-Reconfigure triggert Repaint im CodeMirror, falls wir spaeter modusabhaengige Anpassungen brauchen.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Achtung: Reihenfolge der DispatchJs-Calls vs. PostMessage ist nicht garantiert symmetrisch — das gehoert in die Doku.

---

### Aufgabe 015: Cheat-Sheet-Drag-Position clampen

**Status:** geplant
**Prioritaet:** kritisch
**Erstellt:** 2026-03-15
**Verantwortlich:** Architektur-Runde

#### Beschreibung

Beim Resize aendert sich die Editor-Hoehe und damit die Y-Positionen der Marker. Der updateListener im CodeMirror fuegt einen geometryChanged-Pfad ein, der die Marker-Lane neu zeichnet (Y proportional zur Line-Position).

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Tests: dotnet test, plus Custom-Smoke ueber die Automation-API (/state, /click, /save).

---

### Aufgabe 016: TOC-Highlight bei Scroll

**Status:** in Bearbeitung
**Prioritaet:** niedrig
**Erstellt:** 2026-04-16
**Verantwortlich:** Ralf K.

#### Beschreibung

Der bestehende Pfad ueber ExecuteScriptAsync skaliert nicht fuer Payloads ueber rund 150 KB. WebView2 truncated den Skript-String stillschweigend, was zu einem JavaScript-Syntax-Fehler oder zu einem Aufruf mit undefined-Argumenten fuehrt. Loesung: PostMessage-Kanal nutzen, der ein eigenes IPC-Protokoll mit groesseren Payloads erlaubt.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Branch-Name: feature/<task-key>. PR mit Screenshots vom View- und Edit-Modus.

---

### Aufgabe 017: External-Change Save-Conflict-Prompt

**Status:** Review
**Prioritaet:** mittel
**Erstellt:** 2026-05-17
**Verantwortlich:** Claude

#### Beschreibung

Der Counter (X/Y) muss live mit dem aktuellen Treffer und der Gesamttreffer-Zahl synchronisiert sein. SearchCursor liefert die Treffer; pro Update wird per dispatchEvent ein lokales Browser-Event ausgeloest, das die HTML-Find-Bar ohne Round-Trip ueber C# aktualisiert.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Vor dem Merge unbedingt manueller Smoke mit einer 100KB+ Datei (Bug-A-Regression-Schutz).

---

### Aufgabe 018: Editor-Toolbar Hotkeys

**Status:** abgeschlossen
**Prioritaet:** hoch
**Erstellt:** 2026-06-18
**Verantwortlich:** Team Folio

#### Beschreibung

Light- und Dark-Mode tauschen die App-Theme-Resources aus. Editor-Farben werden ueber CSS-Custom-Properties gesteuert; ein Compartment-Reconfigure triggert Repaint im CodeMirror, falls wir spaeter modusabhaengige Anpassungen brauchen.

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Achtung: Reihenfolge der DispatchJs-Calls vs. PostMessage ist nicht garantiert symmetrisch — das gehoert in die Doku.

---

### Aufgabe 019: Markdown-Pipeline GFM-Extensions

**Status:** blockiert
**Prioritaet:** kritisch
**Erstellt:** 2026-07-19
**Verantwortlich:** Architektur-Runde

#### Beschreibung

Beim Resize aendert sich die Editor-Hoehe und damit die Y-Positionen der Marker. Der updateListener im CodeMirror fuegt einen geometryChanged-Pfad ein, der die Marker-Lane neu zeichnet (Y proportional zur Line-Position).

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Tests: dotnet test, plus Custom-Smoke ueber die Automation-API (/state, /click, /save).

---

### Aufgabe 020: WebView2-Bridge-Channel registrieren

**Status:** geplant
**Prioritaet:** niedrig
**Erstellt:** 2026-08-20
**Verantwortlich:** Ralf K.

#### Beschreibung

Der bestehende Pfad ueber ExecuteScriptAsync skaliert nicht fuer Payloads ueber rund 150 KB. WebView2 truncated den Skript-String stillschweigend, was zu einem JavaScript-Syntax-Fehler oder zu einem Aufruf mit undefined-Argumenten fuehrt. Loesung: PostMessage-Kanal nutzen, der ein eigenes IPC-Protokoll mit groesseren Payloads erlaubt.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Branch-Name: feature/<task-key>. PR mit Screenshots vom View- und Edit-Modus.

---

### Aufgabe 021: Find-Bar Counter aktualisieren

**Status:** in Bearbeitung
**Prioritaet:** mittel
**Erstellt:** 2026-09-21
**Verantwortlich:** Claude

#### Beschreibung

Der Counter (X/Y) muss live mit dem aktuellen Treffer und der Gesamttreffer-Zahl synchronisiert sein. SearchCursor liefert die Treffer; pro Update wird per dispatchEvent ein lokales Browser-Event ausgeloest, das die HTML-Find-Bar ohne Round-Trip ueber C# aktualisiert.

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Vor dem Merge unbedingt manueller Smoke mit einer 100KB+ Datei (Bug-A-Regression-Schutz).

---

### Aufgabe 022: Theme-Sync zwischen Shell und Editor

**Status:** Review
**Prioritaet:** hoch
**Erstellt:** 2026-10-22
**Verantwortlich:** Team Folio

#### Beschreibung

Light- und Dark-Mode tauschen die App-Theme-Resources aus. Editor-Farben werden ueber CSS-Custom-Properties gesteuert; ein Compartment-Reconfigure triggert Repaint im CodeMirror, falls wir spaeter modusabhaengige Anpassungen brauchen.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Achtung: Reihenfolge der DispatchJs-Calls vs. PostMessage ist nicht garantiert symmetrisch — das gehoert in die Doku.

---

### Aufgabe 023: Marker-Lane bei Window-Resize neu rendern

**Status:** abgeschlossen
**Prioritaet:** kritisch
**Erstellt:** 2026-11-23
**Verantwortlich:** Architektur-Runde

#### Beschreibung

Beim Resize aendert sich die Editor-Hoehe und damit die Y-Positionen der Marker. Der updateListener im CodeMirror fuegt einen geometryChanged-Pfad ein, der die Marker-Lane neu zeichnet (Y proportional zur Line-Position).

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Tests: dotnet test, plus Custom-Smoke ueber die Automation-API (/state, /click, /save).

---

### Aufgabe 024: Vault-Tree expand-state persistieren

**Status:** blockiert
**Prioritaet:** niedrig
**Erstellt:** 2026-12-24
**Verantwortlich:** Ralf K.

#### Beschreibung

Der bestehende Pfad ueber ExecuteScriptAsync skaliert nicht fuer Payloads ueber rund 150 KB. WebView2 truncated den Skript-String stillschweigend, was zu einem JavaScript-Syntax-Fehler oder zu einem Aufruf mit undefined-Argumenten fuehrt. Loesung: PostMessage-Kanal nutzen, der ein eigenes IPC-Protokoll mit groesseren Payloads erlaubt.

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Branch-Name: feature/<task-key>. PR mit Screenshots vom View- und Edit-Modus.

---

### Aufgabe 025: Cheat-Sheet-Drag-Position clampen

**Status:** geplant
**Prioritaet:** mittel
**Erstellt:** 2026-01-25
**Verantwortlich:** Claude

#### Beschreibung

Der Counter (X/Y) muss live mit dem aktuellen Treffer und der Gesamttreffer-Zahl synchronisiert sein. SearchCursor liefert die Treffer; pro Update wird per dispatchEvent ein lokales Browser-Event ausgeloest, das die HTML-Find-Bar ohne Round-Trip ueber C# aktualisiert.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Vor dem Merge unbedingt manueller Smoke mit einer 100KB+ Datei (Bug-A-Regression-Schutz).

---

### Aufgabe 026: TOC-Highlight bei Scroll

**Status:** in Bearbeitung
**Prioritaet:** hoch
**Erstellt:** 2026-02-26
**Verantwortlich:** Team Folio

#### Beschreibung

Light- und Dark-Mode tauschen die App-Theme-Resources aus. Editor-Farben werden ueber CSS-Custom-Properties gesteuert; ein Compartment-Reconfigure triggert Repaint im CodeMirror, falls wir spaeter modusabhaengige Anpassungen brauchen.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Achtung: Reihenfolge der DispatchJs-Calls vs. PostMessage ist nicht garantiert symmetrisch — das gehoert in die Doku.

---

### Aufgabe 027: External-Change Save-Conflict-Prompt

**Status:** Review
**Prioritaet:** kritisch
**Erstellt:** 2026-03-27
**Verantwortlich:** Architektur-Runde

#### Beschreibung

Beim Resize aendert sich die Editor-Hoehe und damit die Y-Positionen der Marker. Der updateListener im CodeMirror fuegt einen geometryChanged-Pfad ein, der die Marker-Lane neu zeichnet (Y proportional zur Line-Position).

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Tests: dotnet test, plus Custom-Smoke ueber die Automation-API (/state, /click, /save).

---

### Aufgabe 028: Editor-Toolbar Hotkeys

**Status:** abgeschlossen
**Prioritaet:** niedrig
**Erstellt:** 2026-04-28
**Verantwortlich:** Ralf K.

#### Beschreibung

Der bestehende Pfad ueber ExecuteScriptAsync skaliert nicht fuer Payloads ueber rund 150 KB. WebView2 truncated den Skript-String stillschweigend, was zu einem JavaScript-Syntax-Fehler oder zu einem Aufruf mit undefined-Argumenten fuehrt. Loesung: PostMessage-Kanal nutzen, der ein eigenes IPC-Protokoll mit groesseren Payloads erlaubt.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Branch-Name: feature/<task-key>. PR mit Screenshots vom View- und Edit-Modus.

---

### Aufgabe 029: Markdown-Pipeline GFM-Extensions

**Status:** blockiert
**Prioritaet:** mittel
**Erstellt:** 2026-05-01
**Verantwortlich:** Claude

#### Beschreibung

Der Counter (X/Y) muss live mit dem aktuellen Treffer und der Gesamttreffer-Zahl synchronisiert sein. SearchCursor liefert die Treffer; pro Update wird per dispatchEvent ein lokales Browser-Event ausgeloest, das die HTML-Find-Bar ohne Round-Trip ueber C# aktualisiert.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Vor dem Merge unbedingt manueller Smoke mit einer 100KB+ Datei (Bug-A-Regression-Schutz).

---

### Aufgabe 030: WebView2-Bridge-Channel registrieren

**Status:** geplant
**Prioritaet:** hoch
**Erstellt:** 2026-06-02
**Verantwortlich:** Team Folio

#### Beschreibung

Light- und Dark-Mode tauschen die App-Theme-Resources aus. Editor-Farben werden ueber CSS-Custom-Properties gesteuert; ein Compartment-Reconfigure triggert Repaint im CodeMirror, falls wir spaeter modusabhaengige Anpassungen brauchen.

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Achtung: Reihenfolge der DispatchJs-Calls vs. PostMessage ist nicht garantiert symmetrisch — das gehoert in die Doku.

---

### Aufgabe 031: Find-Bar Counter aktualisieren

**Status:** in Bearbeitung
**Prioritaet:** kritisch
**Erstellt:** 2026-07-03
**Verantwortlich:** Architektur-Runde

#### Beschreibung

Beim Resize aendert sich die Editor-Hoehe und damit die Y-Positionen der Marker. Der updateListener im CodeMirror fuegt einen geometryChanged-Pfad ein, der die Marker-Lane neu zeichnet (Y proportional zur Line-Position).

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Tests: dotnet test, plus Custom-Smoke ueber die Automation-API (/state, /click, /save).

---

### Aufgabe 032: Theme-Sync zwischen Shell und Editor

**Status:** Review
**Prioritaet:** niedrig
**Erstellt:** 2026-08-04
**Verantwortlich:** Ralf K.

#### Beschreibung

Der bestehende Pfad ueber ExecuteScriptAsync skaliert nicht fuer Payloads ueber rund 150 KB. WebView2 truncated den Skript-String stillschweigend, was zu einem JavaScript-Syntax-Fehler oder zu einem Aufruf mit undefined-Argumenten fuehrt. Loesung: PostMessage-Kanal nutzen, der ein eigenes IPC-Protokoll mit groesseren Payloads erlaubt.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Branch-Name: feature/<task-key>. PR mit Screenshots vom View- und Edit-Modus.

---

### Aufgabe 033: Marker-Lane bei Window-Resize neu rendern

**Status:** abgeschlossen
**Prioritaet:** mittel
**Erstellt:** 2026-09-05
**Verantwortlich:** Claude

#### Beschreibung

Der Counter (X/Y) muss live mit dem aktuellen Treffer und der Gesamttreffer-Zahl synchronisiert sein. SearchCursor liefert die Treffer; pro Update wird per dispatchEvent ein lokales Browser-Event ausgeloest, das die HTML-Find-Bar ohne Round-Trip ueber C# aktualisiert.

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Vor dem Merge unbedingt manueller Smoke mit einer 100KB+ Datei (Bug-A-Regression-Schutz).

---

### Aufgabe 034: Vault-Tree expand-state persistieren

**Status:** blockiert
**Prioritaet:** hoch
**Erstellt:** 2026-10-06
**Verantwortlich:** Team Folio

#### Beschreibung

Light- und Dark-Mode tauschen die App-Theme-Resources aus. Editor-Farben werden ueber CSS-Custom-Properties gesteuert; ein Compartment-Reconfigure triggert Repaint im CodeMirror, falls wir spaeter modusabhaengige Anpassungen brauchen.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Achtung: Reihenfolge der DispatchJs-Calls vs. PostMessage ist nicht garantiert symmetrisch — das gehoert in die Doku.

---

### Aufgabe 035: Cheat-Sheet-Drag-Position clampen

**Status:** geplant
**Prioritaet:** kritisch
**Erstellt:** 2026-11-07
**Verantwortlich:** Architektur-Runde

#### Beschreibung

Beim Resize aendert sich die Editor-Hoehe und damit die Y-Positionen der Marker. Der updateListener im CodeMirror fuegt einen geometryChanged-Pfad ein, der die Marker-Lane neu zeichnet (Y proportional zur Line-Position).

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Tests: dotnet test, plus Custom-Smoke ueber die Automation-API (/state, /click, /save).

---

### Aufgabe 036: TOC-Highlight bei Scroll

**Status:** in Bearbeitung
**Prioritaet:** niedrig
**Erstellt:** 2026-12-08
**Verantwortlich:** Ralf K.

#### Beschreibung

Der bestehende Pfad ueber ExecuteScriptAsync skaliert nicht fuer Payloads ueber rund 150 KB. WebView2 truncated den Skript-String stillschweigend, was zu einem JavaScript-Syntax-Fehler oder zu einem Aufruf mit undefined-Argumenten fuehrt. Loesung: PostMessage-Kanal nutzen, der ein eigenes IPC-Protokoll mit groesseren Payloads erlaubt.

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Branch-Name: feature/<task-key>. PR mit Screenshots vom View- und Edit-Modus.

---

### Aufgabe 037: External-Change Save-Conflict-Prompt

**Status:** Review
**Prioritaet:** mittel
**Erstellt:** 2026-01-09
**Verantwortlich:** Claude

#### Beschreibung

Der Counter (X/Y) muss live mit dem aktuellen Treffer und der Gesamttreffer-Zahl synchronisiert sein. SearchCursor liefert die Treffer; pro Update wird per dispatchEvent ein lokales Browser-Event ausgeloest, das die HTML-Find-Bar ohne Round-Trip ueber C# aktualisiert.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Vor dem Merge unbedingt manueller Smoke mit einer 100KB+ Datei (Bug-A-Regression-Schutz).

---

### Aufgabe 038: Editor-Toolbar Hotkeys

**Status:** abgeschlossen
**Prioritaet:** hoch
**Erstellt:** 2026-02-10
**Verantwortlich:** Team Folio

#### Beschreibung

Light- und Dark-Mode tauschen die App-Theme-Resources aus. Editor-Farben werden ueber CSS-Custom-Properties gesteuert; ein Compartment-Reconfigure triggert Repaint im CodeMirror, falls wir spaeter modusabhaengige Anpassungen brauchen.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Achtung: Reihenfolge der DispatchJs-Calls vs. PostMessage ist nicht garantiert symmetrisch — das gehoert in die Doku.

---

### Aufgabe 039: Markdown-Pipeline GFM-Extensions

**Status:** blockiert
**Prioritaet:** kritisch
**Erstellt:** 2026-03-11
**Verantwortlich:** Architektur-Runde

#### Beschreibung

Beim Resize aendert sich die Editor-Hoehe und damit die Y-Positionen der Marker. Der updateListener im CodeMirror fuegt einen geometryChanged-Pfad ein, der die Marker-Lane neu zeichnet (Y proportional zur Line-Position).

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Tests: dotnet test, plus Custom-Smoke ueber die Automation-API (/state, /click, /save).

---

### Aufgabe 040: WebView2-Bridge-Channel registrieren

**Status:** geplant
**Prioritaet:** niedrig
**Erstellt:** 2026-04-12
**Verantwortlich:** Ralf K.

#### Beschreibung

Der bestehende Pfad ueber ExecuteScriptAsync skaliert nicht fuer Payloads ueber rund 150 KB. WebView2 truncated den Skript-String stillschweigend, was zu einem JavaScript-Syntax-Fehler oder zu einem Aufruf mit undefined-Argumenten fuehrt. Loesung: PostMessage-Kanal nutzen, der ein eigenes IPC-Protokoll mit groesseren Payloads erlaubt.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Branch-Name: feature/<task-key>. PR mit Screenshots vom View- und Edit-Modus.

---

### Aufgabe 041: Find-Bar Counter aktualisieren

**Status:** in Bearbeitung
**Prioritaet:** mittel
**Erstellt:** 2026-05-13
**Verantwortlich:** Claude

#### Beschreibung

Der Counter (X/Y) muss live mit dem aktuellen Treffer und der Gesamttreffer-Zahl synchronisiert sein. SearchCursor liefert die Treffer; pro Update wird per dispatchEvent ein lokales Browser-Event ausgeloest, das die HTML-Find-Bar ohne Round-Trip ueber C# aktualisiert.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Vor dem Merge unbedingt manueller Smoke mit einer 100KB+ Datei (Bug-A-Regression-Schutz).

---

### Aufgabe 042: Theme-Sync zwischen Shell und Editor

**Status:** Review
**Prioritaet:** hoch
**Erstellt:** 2026-06-14
**Verantwortlich:** Team Folio

#### Beschreibung

Light- und Dark-Mode tauschen die App-Theme-Resources aus. Editor-Farben werden ueber CSS-Custom-Properties gesteuert; ein Compartment-Reconfigure triggert Repaint im CodeMirror, falls wir spaeter modusabhaengige Anpassungen brauchen.

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Achtung: Reihenfolge der DispatchJs-Calls vs. PostMessage ist nicht garantiert symmetrisch — das gehoert in die Doku.

---

### Aufgabe 043: Marker-Lane bei Window-Resize neu rendern

**Status:** abgeschlossen
**Prioritaet:** kritisch
**Erstellt:** 2026-07-15
**Verantwortlich:** Architektur-Runde

#### Beschreibung

Beim Resize aendert sich die Editor-Hoehe und damit die Y-Positionen der Marker. Der updateListener im CodeMirror fuegt einen geometryChanged-Pfad ein, der die Marker-Lane neu zeichnet (Y proportional zur Line-Position).

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Tests: dotnet test, plus Custom-Smoke ueber die Automation-API (/state, /click, /save).

---

### Aufgabe 044: Vault-Tree expand-state persistieren

**Status:** blockiert
**Prioritaet:** niedrig
**Erstellt:** 2026-08-16
**Verantwortlich:** Ralf K.

#### Beschreibung

Der bestehende Pfad ueber ExecuteScriptAsync skaliert nicht fuer Payloads ueber rund 150 KB. WebView2 truncated den Skript-String stillschweigend, was zu einem JavaScript-Syntax-Fehler oder zu einem Aufruf mit undefined-Argumenten fuehrt. Loesung: PostMessage-Kanal nutzen, der ein eigenes IPC-Protokoll mit groesseren Payloads erlaubt.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Branch-Name: feature/<task-key>. PR mit Screenshots vom View- und Edit-Modus.

---

### Aufgabe 045: Cheat-Sheet-Drag-Position clampen

**Status:** geplant
**Prioritaet:** mittel
**Erstellt:** 2026-09-17
**Verantwortlich:** Claude

#### Beschreibung

Der Counter (X/Y) muss live mit dem aktuellen Treffer und der Gesamttreffer-Zahl synchronisiert sein. SearchCursor liefert die Treffer; pro Update wird per dispatchEvent ein lokales Browser-Event ausgeloest, das die HTML-Find-Bar ohne Round-Trip ueber C# aktualisiert.

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Vor dem Merge unbedingt manueller Smoke mit einer 100KB+ Datei (Bug-A-Regression-Schutz).

---

### Aufgabe 046: TOC-Highlight bei Scroll

**Status:** in Bearbeitung
**Prioritaet:** hoch
**Erstellt:** 2026-10-18
**Verantwortlich:** Team Folio

#### Beschreibung

Light- und Dark-Mode tauschen die App-Theme-Resources aus. Editor-Farben werden ueber CSS-Custom-Properties gesteuert; ein Compartment-Reconfigure triggert Repaint im CodeMirror, falls wir spaeter modusabhaengige Anpassungen brauchen.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Achtung: Reihenfolge der DispatchJs-Calls vs. PostMessage ist nicht garantiert symmetrisch — das gehoert in die Doku.

---

### Aufgabe 047: External-Change Save-Conflict-Prompt

**Status:** Review
**Prioritaet:** kritisch
**Erstellt:** 2026-11-19
**Verantwortlich:** Architektur-Runde

#### Beschreibung

Beim Resize aendert sich die Editor-Hoehe und damit die Y-Positionen der Marker. Der updateListener im CodeMirror fuegt einen geometryChanged-Pfad ein, der die Marker-Lane neu zeichnet (Y proportional zur Line-Position).

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Tests: dotnet test, plus Custom-Smoke ueber die Automation-API (/state, /click, /save).

---

### Aufgabe 048: Editor-Toolbar Hotkeys

**Status:** abgeschlossen
**Prioritaet:** niedrig
**Erstellt:** 2026-12-20
**Verantwortlich:** Ralf K.

#### Beschreibung

Der bestehende Pfad ueber ExecuteScriptAsync skaliert nicht fuer Payloads ueber rund 150 KB. WebView2 truncated den Skript-String stillschweigend, was zu einem JavaScript-Syntax-Fehler oder zu einem Aufruf mit undefined-Argumenten fuehrt. Loesung: PostMessage-Kanal nutzen, der ein eigenes IPC-Protokoll mit groesseren Payloads erlaubt.

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Branch-Name: feature/<task-key>. PR mit Screenshots vom View- und Edit-Modus.

---

### Aufgabe 049: Markdown-Pipeline GFM-Extensions

**Status:** blockiert
**Prioritaet:** mittel
**Erstellt:** 2026-01-21
**Verantwortlich:** Claude

#### Beschreibung

Der Counter (X/Y) muss live mit dem aktuellen Treffer und der Gesamttreffer-Zahl synchronisiert sein. SearchCursor liefert die Treffer; pro Update wird per dispatchEvent ein lokales Browser-Event ausgeloest, das die HTML-Find-Bar ohne Round-Trip ueber C# aktualisiert.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Vor dem Merge unbedingt manueller Smoke mit einer 100KB+ Datei (Bug-A-Regression-Schutz).

---

### Aufgabe 050: WebView2-Bridge-Channel registrieren

**Status:** geplant
**Prioritaet:** hoch
**Erstellt:** 2026-02-22
**Verantwortlich:** Team Folio

#### Beschreibung

Light- und Dark-Mode tauschen die App-Theme-Resources aus. Editor-Farben werden ueber CSS-Custom-Properties gesteuert; ein Compartment-Reconfigure triggert Repaint im CodeMirror, falls wir spaeter modusabhaengige Anpassungen brauchen.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Achtung: Reihenfolge der DispatchJs-Calls vs. PostMessage ist nicht garantiert symmetrisch — das gehoert in die Doku.

---

### Aufgabe 051: Find-Bar Counter aktualisieren

**Status:** in Bearbeitung
**Prioritaet:** kritisch
**Erstellt:** 2026-03-23
**Verantwortlich:** Architektur-Runde

#### Beschreibung

Beim Resize aendert sich die Editor-Hoehe und damit die Y-Positionen der Marker. Der updateListener im CodeMirror fuegt einen geometryChanged-Pfad ein, der die Marker-Lane neu zeichnet (Y proportional zur Line-Position).

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Tests: dotnet test, plus Custom-Smoke ueber die Automation-API (/state, /click, /save).

---

### Aufgabe 052: Theme-Sync zwischen Shell und Editor

**Status:** Review
**Prioritaet:** niedrig
**Erstellt:** 2026-04-24
**Verantwortlich:** Ralf K.

#### Beschreibung

Der bestehende Pfad ueber ExecuteScriptAsync skaliert nicht fuer Payloads ueber rund 150 KB. WebView2 truncated den Skript-String stillschweigend, was zu einem JavaScript-Syntax-Fehler oder zu einem Aufruf mit undefined-Argumenten fuehrt. Loesung: PostMessage-Kanal nutzen, der ein eigenes IPC-Protokoll mit groesseren Payloads erlaubt.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Branch-Name: feature/<task-key>. PR mit Screenshots vom View- und Edit-Modus.

---

### Aufgabe 053: Marker-Lane bei Window-Resize neu rendern

**Status:** abgeschlossen
**Prioritaet:** mittel
**Erstellt:** 2026-05-25
**Verantwortlich:** Claude

#### Beschreibung

Der Counter (X/Y) muss live mit dem aktuellen Treffer und der Gesamttreffer-Zahl synchronisiert sein. SearchCursor liefert die Treffer; pro Update wird per dispatchEvent ein lokales Browser-Event ausgeloest, das die HTML-Find-Bar ohne Round-Trip ueber C# aktualisiert.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Vor dem Merge unbedingt manueller Smoke mit einer 100KB+ Datei (Bug-A-Regression-Schutz).

---

### Aufgabe 054: Vault-Tree expand-state persistieren

**Status:** blockiert
**Prioritaet:** hoch
**Erstellt:** 2026-06-26
**Verantwortlich:** Team Folio

#### Beschreibung

Light- und Dark-Mode tauschen die App-Theme-Resources aus. Editor-Farben werden ueber CSS-Custom-Properties gesteuert; ein Compartment-Reconfigure triggert Repaint im CodeMirror, falls wir spaeter modusabhaengige Anpassungen brauchen.

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Achtung: Reihenfolge der DispatchJs-Calls vs. PostMessage ist nicht garantiert symmetrisch — das gehoert in die Doku.

---

### Aufgabe 055: Cheat-Sheet-Drag-Position clampen

**Status:** geplant
**Prioritaet:** kritisch
**Erstellt:** 2026-07-27
**Verantwortlich:** Architektur-Runde

#### Beschreibung

Beim Resize aendert sich die Editor-Hoehe und damit die Y-Positionen der Marker. Der updateListener im CodeMirror fuegt einen geometryChanged-Pfad ein, der die Marker-Lane neu zeichnet (Y proportional zur Line-Position).

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Tests: dotnet test, plus Custom-Smoke ueber die Automation-API (/state, /click, /save).

---

### Aufgabe 056: TOC-Highlight bei Scroll

**Status:** in Bearbeitung
**Prioritaet:** niedrig
**Erstellt:** 2026-08-28
**Verantwortlich:** Ralf K.

#### Beschreibung

Der bestehende Pfad ueber ExecuteScriptAsync skaliert nicht fuer Payloads ueber rund 150 KB. WebView2 truncated den Skript-String stillschweigend, was zu einem JavaScript-Syntax-Fehler oder zu einem Aufruf mit undefined-Argumenten fuehrt. Loesung: PostMessage-Kanal nutzen, der ein eigenes IPC-Protokoll mit groesseren Payloads erlaubt.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Branch-Name: feature/<task-key>. PR mit Screenshots vom View- und Edit-Modus.

---

### Aufgabe 057: External-Change Save-Conflict-Prompt

**Status:** Review
**Prioritaet:** mittel
**Erstellt:** 2026-09-01
**Verantwortlich:** Claude

#### Beschreibung

Der Counter (X/Y) muss live mit dem aktuellen Treffer und der Gesamttreffer-Zahl synchronisiert sein. SearchCursor liefert die Treffer; pro Update wird per dispatchEvent ein lokales Browser-Event ausgeloest, das die HTML-Find-Bar ohne Round-Trip ueber C# aktualisiert.

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Vor dem Merge unbedingt manueller Smoke mit einer 100KB+ Datei (Bug-A-Regression-Schutz).

---

### Aufgabe 058: Editor-Toolbar Hotkeys

**Status:** abgeschlossen
**Prioritaet:** hoch
**Erstellt:** 2026-10-02
**Verantwortlich:** Team Folio

#### Beschreibung

Light- und Dark-Mode tauschen die App-Theme-Resources aus. Editor-Farben werden ueber CSS-Custom-Properties gesteuert; ein Compartment-Reconfigure triggert Repaint im CodeMirror, falls wir spaeter modusabhaengige Anpassungen brauchen.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Achtung: Reihenfolge der DispatchJs-Calls vs. PostMessage ist nicht garantiert symmetrisch — das gehoert in die Doku.

---

### Aufgabe 059: Markdown-Pipeline GFM-Extensions

**Status:** blockiert
**Prioritaet:** kritisch
**Erstellt:** 2026-11-03
**Verantwortlich:** Architektur-Runde

#### Beschreibung

Beim Resize aendert sich die Editor-Hoehe und damit die Y-Positionen der Marker. Der updateListener im CodeMirror fuegt einen geometryChanged-Pfad ein, der die Marker-Lane neu zeichnet (Y proportional zur Line-Position).

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Tests: dotnet test, plus Custom-Smoke ueber die Automation-API (/state, /click, /save).

---

### Aufgabe 060: WebView2-Bridge-Channel registrieren

**Status:** geplant
**Prioritaet:** niedrig
**Erstellt:** 2026-12-04
**Verantwortlich:** Ralf K.

#### Beschreibung

Der bestehende Pfad ueber ExecuteScriptAsync skaliert nicht fuer Payloads ueber rund 150 KB. WebView2 truncated den Skript-String stillschweigend, was zu einem JavaScript-Syntax-Fehler oder zu einem Aufruf mit undefined-Argumenten fuehrt. Loesung: PostMessage-Kanal nutzen, der ein eigenes IPC-Protokoll mit groesseren Payloads erlaubt.

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Branch-Name: feature/<task-key>. PR mit Screenshots vom View- und Edit-Modus.

---

### Aufgabe 061: Find-Bar Counter aktualisieren

**Status:** in Bearbeitung
**Prioritaet:** mittel
**Erstellt:** 2026-01-05
**Verantwortlich:** Claude

#### Beschreibung

Der Counter (X/Y) muss live mit dem aktuellen Treffer und der Gesamttreffer-Zahl synchronisiert sein. SearchCursor liefert die Treffer; pro Update wird per dispatchEvent ein lokales Browser-Event ausgeloest, das die HTML-Find-Bar ohne Round-Trip ueber C# aktualisiert.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Vor dem Merge unbedingt manueller Smoke mit einer 100KB+ Datei (Bug-A-Regression-Schutz).

---

### Aufgabe 062: Theme-Sync zwischen Shell und Editor

**Status:** Review
**Prioritaet:** hoch
**Erstellt:** 2026-02-06
**Verantwortlich:** Team Folio

#### Beschreibung

Light- und Dark-Mode tauschen die App-Theme-Resources aus. Editor-Farben werden ueber CSS-Custom-Properties gesteuert; ein Compartment-Reconfigure triggert Repaint im CodeMirror, falls wir spaeter modusabhaengige Anpassungen brauchen.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Achtung: Reihenfolge der DispatchJs-Calls vs. PostMessage ist nicht garantiert symmetrisch — das gehoert in die Doku.

---

### Aufgabe 063: Marker-Lane bei Window-Resize neu rendern

**Status:** abgeschlossen
**Prioritaet:** kritisch
**Erstellt:** 2026-03-07
**Verantwortlich:** Architektur-Runde

#### Beschreibung

Beim Resize aendert sich die Editor-Hoehe und damit die Y-Positionen der Marker. Der updateListener im CodeMirror fuegt einen geometryChanged-Pfad ein, der die Marker-Lane neu zeichnet (Y proportional zur Line-Position).

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Tests: dotnet test, plus Custom-Smoke ueber die Automation-API (/state, /click, /save).

---

### Aufgabe 064: Vault-Tree expand-state persistieren

**Status:** blockiert
**Prioritaet:** niedrig
**Erstellt:** 2026-04-08
**Verantwortlich:** Ralf K.

#### Beschreibung

Der bestehende Pfad ueber ExecuteScriptAsync skaliert nicht fuer Payloads ueber rund 150 KB. WebView2 truncated den Skript-String stillschweigend, was zu einem JavaScript-Syntax-Fehler oder zu einem Aufruf mit undefined-Argumenten fuehrt. Loesung: PostMessage-Kanal nutzen, der ein eigenes IPC-Protokoll mit groesseren Payloads erlaubt.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Branch-Name: feature/<task-key>. PR mit Screenshots vom View- und Edit-Modus.

---

### Aufgabe 065: Cheat-Sheet-Drag-Position clampen

**Status:** geplant
**Prioritaet:** mittel
**Erstellt:** 2026-05-09
**Verantwortlich:** Claude

#### Beschreibung

Der Counter (X/Y) muss live mit dem aktuellen Treffer und der Gesamttreffer-Zahl synchronisiert sein. SearchCursor liefert die Treffer; pro Update wird per dispatchEvent ein lokales Browser-Event ausgeloest, das die HTML-Find-Bar ohne Round-Trip ueber C# aktualisiert.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Vor dem Merge unbedingt manueller Smoke mit einer 100KB+ Datei (Bug-A-Regression-Schutz).

---

### Aufgabe 066: TOC-Highlight bei Scroll

**Status:** in Bearbeitung
**Prioritaet:** hoch
**Erstellt:** 2026-06-10
**Verantwortlich:** Team Folio

#### Beschreibung

Light- und Dark-Mode tauschen die App-Theme-Resources aus. Editor-Farben werden ueber CSS-Custom-Properties gesteuert; ein Compartment-Reconfigure triggert Repaint im CodeMirror, falls wir spaeter modusabhaengige Anpassungen brauchen.

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Achtung: Reihenfolge der DispatchJs-Calls vs. PostMessage ist nicht garantiert symmetrisch — das gehoert in die Doku.

---

### Aufgabe 067: External-Change Save-Conflict-Prompt

**Status:** Review
**Prioritaet:** kritisch
**Erstellt:** 2026-07-11
**Verantwortlich:** Architektur-Runde

#### Beschreibung

Beim Resize aendert sich die Editor-Hoehe und damit die Y-Positionen der Marker. Der updateListener im CodeMirror fuegt einen geometryChanged-Pfad ein, der die Marker-Lane neu zeichnet (Y proportional zur Line-Position).

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Tests: dotnet test, plus Custom-Smoke ueber die Automation-API (/state, /click, /save).

---

### Aufgabe 068: Editor-Toolbar Hotkeys

**Status:** abgeschlossen
**Prioritaet:** niedrig
**Erstellt:** 2026-08-12
**Verantwortlich:** Ralf K.

#### Beschreibung

Der bestehende Pfad ueber ExecuteScriptAsync skaliert nicht fuer Payloads ueber rund 150 KB. WebView2 truncated den Skript-String stillschweigend, was zu einem JavaScript-Syntax-Fehler oder zu einem Aufruf mit undefined-Argumenten fuehrt. Loesung: PostMessage-Kanal nutzen, der ein eigenes IPC-Protokoll mit groesseren Payloads erlaubt.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Branch-Name: feature/<task-key>. PR mit Screenshots vom View- und Edit-Modus.

---

### Aufgabe 069: Markdown-Pipeline GFM-Extensions

**Status:** blockiert
**Prioritaet:** mittel
**Erstellt:** 2026-09-13
**Verantwortlich:** Claude

#### Beschreibung

Der Counter (X/Y) muss live mit dem aktuellen Treffer und der Gesamttreffer-Zahl synchronisiert sein. SearchCursor liefert die Treffer; pro Update wird per dispatchEvent ein lokales Browser-Event ausgeloest, das die HTML-Find-Bar ohne Round-Trip ueber C# aktualisiert.

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Vor dem Merge unbedingt manueller Smoke mit einer 100KB+ Datei (Bug-A-Regression-Schutz).

---

### Aufgabe 070: WebView2-Bridge-Channel registrieren

**Status:** geplant
**Prioritaet:** hoch
**Erstellt:** 2026-10-14
**Verantwortlich:** Team Folio

#### Beschreibung

Light- und Dark-Mode tauschen die App-Theme-Resources aus. Editor-Farben werden ueber CSS-Custom-Properties gesteuert; ein Compartment-Reconfigure triggert Repaint im CodeMirror, falls wir spaeter modusabhaengige Anpassungen brauchen.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Achtung: Reihenfolge der DispatchJs-Calls vs. PostMessage ist nicht garantiert symmetrisch — das gehoert in die Doku.

---

### Aufgabe 071: Find-Bar Counter aktualisieren

**Status:** in Bearbeitung
**Prioritaet:** kritisch
**Erstellt:** 2026-11-15
**Verantwortlich:** Architektur-Runde

#### Beschreibung

Beim Resize aendert sich die Editor-Hoehe und damit die Y-Positionen der Marker. Der updateListener im CodeMirror fuegt einen geometryChanged-Pfad ein, der die Marker-Lane neu zeichnet (Y proportional zur Line-Position).

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Tests: dotnet test, plus Custom-Smoke ueber die Automation-API (/state, /click, /save).

---

### Aufgabe 072: Theme-Sync zwischen Shell und Editor

**Status:** Review
**Prioritaet:** niedrig
**Erstellt:** 2026-12-16
**Verantwortlich:** Ralf K.

#### Beschreibung

Der bestehende Pfad ueber ExecuteScriptAsync skaliert nicht fuer Payloads ueber rund 150 KB. WebView2 truncated den Skript-String stillschweigend, was zu einem JavaScript-Syntax-Fehler oder zu einem Aufruf mit undefined-Argumenten fuehrt. Loesung: PostMessage-Kanal nutzen, der ein eigenes IPC-Protokoll mit groesseren Payloads erlaubt.

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Branch-Name: feature/<task-key>. PR mit Screenshots vom View- und Edit-Modus.

---

### Aufgabe 073: Marker-Lane bei Window-Resize neu rendern

**Status:** abgeschlossen
**Prioritaet:** mittel
**Erstellt:** 2026-01-17
**Verantwortlich:** Claude

#### Beschreibung

Der Counter (X/Y) muss live mit dem aktuellen Treffer und der Gesamttreffer-Zahl synchronisiert sein. SearchCursor liefert die Treffer; pro Update wird per dispatchEvent ein lokales Browser-Event ausgeloest, das die HTML-Find-Bar ohne Round-Trip ueber C# aktualisiert.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Vor dem Merge unbedingt manueller Smoke mit einer 100KB+ Datei (Bug-A-Regression-Schutz).

---

### Aufgabe 074: Vault-Tree expand-state persistieren

**Status:** blockiert
**Prioritaet:** hoch
**Erstellt:** 2026-02-18
**Verantwortlich:** Team Folio

#### Beschreibung

Light- und Dark-Mode tauschen die App-Theme-Resources aus. Editor-Farben werden ueber CSS-Custom-Properties gesteuert; ein Compartment-Reconfigure triggert Repaint im CodeMirror, falls wir spaeter modusabhaengige Anpassungen brauchen.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Achtung: Reihenfolge der DispatchJs-Calls vs. PostMessage ist nicht garantiert symmetrisch — das gehoert in die Doku.

---

### Aufgabe 075: Cheat-Sheet-Drag-Position clampen

**Status:** geplant
**Prioritaet:** kritisch
**Erstellt:** 2026-03-19
**Verantwortlich:** Architektur-Runde

#### Beschreibung

Beim Resize aendert sich die Editor-Hoehe und damit die Y-Positionen der Marker. Der updateListener im CodeMirror fuegt einen geometryChanged-Pfad ein, der die Marker-Lane neu zeichnet (Y proportional zur Line-Position).

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Tests: dotnet test, plus Custom-Smoke ueber die Automation-API (/state, /click, /save).

---

### Aufgabe 076: TOC-Highlight bei Scroll

**Status:** in Bearbeitung
**Prioritaet:** niedrig
**Erstellt:** 2026-04-20
**Verantwortlich:** Ralf K.

#### Beschreibung

Der bestehende Pfad ueber ExecuteScriptAsync skaliert nicht fuer Payloads ueber rund 150 KB. WebView2 truncated den Skript-String stillschweigend, was zu einem JavaScript-Syntax-Fehler oder zu einem Aufruf mit undefined-Argumenten fuehrt. Loesung: PostMessage-Kanal nutzen, der ein eigenes IPC-Protokoll mit groesseren Payloads erlaubt.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Branch-Name: feature/<task-key>. PR mit Screenshots vom View- und Edit-Modus.

---

### Aufgabe 077: External-Change Save-Conflict-Prompt

**Status:** Review
**Prioritaet:** mittel
**Erstellt:** 2026-05-21
**Verantwortlich:** Claude

#### Beschreibung

Der Counter (X/Y) muss live mit dem aktuellen Treffer und der Gesamttreffer-Zahl synchronisiert sein. SearchCursor liefert die Treffer; pro Update wird per dispatchEvent ein lokales Browser-Event ausgeloest, das die HTML-Find-Bar ohne Round-Trip ueber C# aktualisiert.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Vor dem Merge unbedingt manueller Smoke mit einer 100KB+ Datei (Bug-A-Regression-Schutz).

---

### Aufgabe 078: Editor-Toolbar Hotkeys

**Status:** abgeschlossen
**Prioritaet:** hoch
**Erstellt:** 2026-06-22
**Verantwortlich:** Team Folio

#### Beschreibung

Light- und Dark-Mode tauschen die App-Theme-Resources aus. Editor-Farben werden ueber CSS-Custom-Properties gesteuert; ein Compartment-Reconfigure triggert Repaint im CodeMirror, falls wir spaeter modusabhaengige Anpassungen brauchen.

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Achtung: Reihenfolge der DispatchJs-Calls vs. PostMessage ist nicht garantiert symmetrisch — das gehoert in die Doku.

---

### Aufgabe 079: Markdown-Pipeline GFM-Extensions

**Status:** blockiert
**Prioritaet:** kritisch
**Erstellt:** 2026-07-23
**Verantwortlich:** Architektur-Runde

#### Beschreibung

Beim Resize aendert sich die Editor-Hoehe und damit die Y-Positionen der Marker. Der updateListener im CodeMirror fuegt einen geometryChanged-Pfad ein, der die Marker-Lane neu zeichnet (Y proportional zur Line-Position).

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Tests: dotnet test, plus Custom-Smoke ueber die Automation-API (/state, /click, /save).

---

### Aufgabe 080: WebView2-Bridge-Channel registrieren

**Status:** geplant
**Prioritaet:** niedrig
**Erstellt:** 2026-08-24
**Verantwortlich:** Ralf K.

#### Beschreibung

Der bestehende Pfad ueber ExecuteScriptAsync skaliert nicht fuer Payloads ueber rund 150 KB. WebView2 truncated den Skript-String stillschweigend, was zu einem JavaScript-Syntax-Fehler oder zu einem Aufruf mit undefined-Argumenten fuehrt. Loesung: PostMessage-Kanal nutzen, der ein eigenes IPC-Protokoll mit groesseren Payloads erlaubt.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Branch-Name: feature/<task-key>. PR mit Screenshots vom View- und Edit-Modus.

---

### Aufgabe 081: Find-Bar Counter aktualisieren

**Status:** in Bearbeitung
**Prioritaet:** mittel
**Erstellt:** 2026-09-25
**Verantwortlich:** Claude

#### Beschreibung

Der Counter (X/Y) muss live mit dem aktuellen Treffer und der Gesamttreffer-Zahl synchronisiert sein. SearchCursor liefert die Treffer; pro Update wird per dispatchEvent ein lokales Browser-Event ausgeloest, das die HTML-Find-Bar ohne Round-Trip ueber C# aktualisiert.

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Vor dem Merge unbedingt manueller Smoke mit einer 100KB+ Datei (Bug-A-Regression-Schutz).

---

### Aufgabe 082: Theme-Sync zwischen Shell und Editor

**Status:** Review
**Prioritaet:** hoch
**Erstellt:** 2026-10-26
**Verantwortlich:** Team Folio

#### Beschreibung

Light- und Dark-Mode tauschen die App-Theme-Resources aus. Editor-Farben werden ueber CSS-Custom-Properties gesteuert; ein Compartment-Reconfigure triggert Repaint im CodeMirror, falls wir spaeter modusabhaengige Anpassungen brauchen.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Achtung: Reihenfolge der DispatchJs-Calls vs. PostMessage ist nicht garantiert symmetrisch — das gehoert in die Doku.

---

### Aufgabe 083: Marker-Lane bei Window-Resize neu rendern

**Status:** abgeschlossen
**Prioritaet:** kritisch
**Erstellt:** 2026-11-27
**Verantwortlich:** Architektur-Runde

#### Beschreibung

Beim Resize aendert sich die Editor-Hoehe und damit die Y-Positionen der Marker. Der updateListener im CodeMirror fuegt einen geometryChanged-Pfad ein, der die Marker-Lane neu zeichnet (Y proportional zur Line-Position).

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Tests: dotnet test, plus Custom-Smoke ueber die Automation-API (/state, /click, /save).

---

### Aufgabe 084: Vault-Tree expand-state persistieren

**Status:** blockiert
**Prioritaet:** niedrig
**Erstellt:** 2026-12-28
**Verantwortlich:** Ralf K.

#### Beschreibung

Der bestehende Pfad ueber ExecuteScriptAsync skaliert nicht fuer Payloads ueber rund 150 KB. WebView2 truncated den Skript-String stillschweigend, was zu einem JavaScript-Syntax-Fehler oder zu einem Aufruf mit undefined-Argumenten fuehrt. Loesung: PostMessage-Kanal nutzen, der ein eigenes IPC-Protokoll mit groesseren Payloads erlaubt.

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Branch-Name: feature/<task-key>. PR mit Screenshots vom View- und Edit-Modus.

---

### Aufgabe 085: Cheat-Sheet-Drag-Position clampen

**Status:** geplant
**Prioritaet:** mittel
**Erstellt:** 2026-01-01
**Verantwortlich:** Claude

#### Beschreibung

Der Counter (X/Y) muss live mit dem aktuellen Treffer und der Gesamttreffer-Zahl synchronisiert sein. SearchCursor liefert die Treffer; pro Update wird per dispatchEvent ein lokales Browser-Event ausgeloest, das die HTML-Find-Bar ohne Round-Trip ueber C# aktualisiert.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Vor dem Merge unbedingt manueller Smoke mit einer 100KB+ Datei (Bug-A-Regression-Schutz).

---

### Aufgabe 086: TOC-Highlight bei Scroll

**Status:** in Bearbeitung
**Prioritaet:** hoch
**Erstellt:** 2026-02-02
**Verantwortlich:** Team Folio

#### Beschreibung

Light- und Dark-Mode tauschen die App-Theme-Resources aus. Editor-Farben werden ueber CSS-Custom-Properties gesteuert; ein Compartment-Reconfigure triggert Repaint im CodeMirror, falls wir spaeter modusabhaengige Anpassungen brauchen.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Achtung: Reihenfolge der DispatchJs-Calls vs. PostMessage ist nicht garantiert symmetrisch — das gehoert in die Doku.

---

### Aufgabe 087: External-Change Save-Conflict-Prompt

**Status:** Review
**Prioritaet:** kritisch
**Erstellt:** 2026-03-03
**Verantwortlich:** Architektur-Runde

#### Beschreibung

Beim Resize aendert sich die Editor-Hoehe und damit die Y-Positionen der Marker. Der updateListener im CodeMirror fuegt einen geometryChanged-Pfad ein, der die Marker-Lane neu zeichnet (Y proportional zur Line-Position).

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Tests: dotnet test, plus Custom-Smoke ueber die Automation-API (/state, /click, /save).

---

### Aufgabe 088: Editor-Toolbar Hotkeys

**Status:** abgeschlossen
**Prioritaet:** niedrig
**Erstellt:** 2026-04-04
**Verantwortlich:** Ralf K.

#### Beschreibung

Der bestehende Pfad ueber ExecuteScriptAsync skaliert nicht fuer Payloads ueber rund 150 KB. WebView2 truncated den Skript-String stillschweigend, was zu einem JavaScript-Syntax-Fehler oder zu einem Aufruf mit undefined-Argumenten fuehrt. Loesung: PostMessage-Kanal nutzen, der ein eigenes IPC-Protokoll mit groesseren Payloads erlaubt.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Branch-Name: feature/<task-key>. PR mit Screenshots vom View- und Edit-Modus.

---

### Aufgabe 089: Markdown-Pipeline GFM-Extensions

**Status:** blockiert
**Prioritaet:** mittel
**Erstellt:** 2026-05-05
**Verantwortlich:** Claude

#### Beschreibung

Der Counter (X/Y) muss live mit dem aktuellen Treffer und der Gesamttreffer-Zahl synchronisiert sein. SearchCursor liefert die Treffer; pro Update wird per dispatchEvent ein lokales Browser-Event ausgeloest, das die HTML-Find-Bar ohne Round-Trip ueber C# aktualisiert.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Vor dem Merge unbedingt manueller Smoke mit einer 100KB+ Datei (Bug-A-Regression-Schutz).

---

### Aufgabe 090: WebView2-Bridge-Channel registrieren

**Status:** geplant
**Prioritaet:** hoch
**Erstellt:** 2026-06-06
**Verantwortlich:** Team Folio

#### Beschreibung

Light- und Dark-Mode tauschen die App-Theme-Resources aus. Editor-Farben werden ueber CSS-Custom-Properties gesteuert; ein Compartment-Reconfigure triggert Repaint im CodeMirror, falls wir spaeter modusabhaengige Anpassungen brauchen.

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Achtung: Reihenfolge der DispatchJs-Calls vs. PostMessage ist nicht garantiert symmetrisch — das gehoert in die Doku.

---

### Aufgabe 091: Find-Bar Counter aktualisieren

**Status:** in Bearbeitung
**Prioritaet:** kritisch
**Erstellt:** 2026-07-07
**Verantwortlich:** Architektur-Runde

#### Beschreibung

Beim Resize aendert sich die Editor-Hoehe und damit die Y-Positionen der Marker. Der updateListener im CodeMirror fuegt einen geometryChanged-Pfad ein, der die Marker-Lane neu zeichnet (Y proportional zur Line-Position).

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Tests: dotnet test, plus Custom-Smoke ueber die Automation-API (/state, /click, /save).

---

### Aufgabe 092: Theme-Sync zwischen Shell und Editor

**Status:** Review
**Prioritaet:** niedrig
**Erstellt:** 2026-08-08
**Verantwortlich:** Ralf K.

#### Beschreibung

Der bestehende Pfad ueber ExecuteScriptAsync skaliert nicht fuer Payloads ueber rund 150 KB. WebView2 truncated den Skript-String stillschweigend, was zu einem JavaScript-Syntax-Fehler oder zu einem Aufruf mit undefined-Argumenten fuehrt. Loesung: PostMessage-Kanal nutzen, der ein eigenes IPC-Protokoll mit groesseren Payloads erlaubt.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Branch-Name: feature/<task-key>. PR mit Screenshots vom View- und Edit-Modus.

---

### Aufgabe 093: Marker-Lane bei Window-Resize neu rendern

**Status:** abgeschlossen
**Prioritaet:** mittel
**Erstellt:** 2026-09-09
**Verantwortlich:** Claude

#### Beschreibung

Der Counter (X/Y) muss live mit dem aktuellen Treffer und der Gesamttreffer-Zahl synchronisiert sein. SearchCursor liefert die Treffer; pro Update wird per dispatchEvent ein lokales Browser-Event ausgeloest, das die HTML-Find-Bar ohne Round-Trip ueber C# aktualisiert.

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Vor dem Merge unbedingt manueller Smoke mit einer 100KB+ Datei (Bug-A-Regression-Schutz).

---

### Aufgabe 094: Vault-Tree expand-state persistieren

**Status:** blockiert
**Prioritaet:** hoch
**Erstellt:** 2026-10-10
**Verantwortlich:** Team Folio

#### Beschreibung

Light- und Dark-Mode tauschen die App-Theme-Resources aus. Editor-Farben werden ueber CSS-Custom-Properties gesteuert; ein Compartment-Reconfigure triggert Repaint im CodeMirror, falls wir spaeter modusabhaengige Anpassungen brauchen.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Achtung: Reihenfolge der DispatchJs-Calls vs. PostMessage ist nicht garantiert symmetrisch — das gehoert in die Doku.

---

### Aufgabe 095: Cheat-Sheet-Drag-Position clampen

**Status:** geplant
**Prioritaet:** kritisch
**Erstellt:** 2026-11-11
**Verantwortlich:** Architektur-Runde

#### Beschreibung

Beim Resize aendert sich die Editor-Hoehe und damit die Y-Positionen der Marker. Der updateListener im CodeMirror fuegt einen geometryChanged-Pfad ein, der die Marker-Lane neu zeichnet (Y proportional zur Line-Position).

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Tests: dotnet test, plus Custom-Smoke ueber die Automation-API (/state, /click, /save).

---

### Aufgabe 096: TOC-Highlight bei Scroll

**Status:** in Bearbeitung
**Prioritaet:** niedrig
**Erstellt:** 2026-12-12
**Verantwortlich:** Ralf K.

#### Beschreibung

Der bestehende Pfad ueber ExecuteScriptAsync skaliert nicht fuer Payloads ueber rund 150 KB. WebView2 truncated den Skript-String stillschweigend, was zu einem JavaScript-Syntax-Fehler oder zu einem Aufruf mit undefined-Argumenten fuehrt. Loesung: PostMessage-Kanal nutzen, der ein eigenes IPC-Protokoll mit groesseren Payloads erlaubt.

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Branch-Name: feature/<task-key>. PR mit Screenshots vom View- und Edit-Modus.

---

### Aufgabe 097: External-Change Save-Conflict-Prompt

**Status:** Review
**Prioritaet:** mittel
**Erstellt:** 2026-01-13
**Verantwortlich:** Claude

#### Beschreibung

Der Counter (X/Y) muss live mit dem aktuellen Treffer und der Gesamttreffer-Zahl synchronisiert sein. SearchCursor liefert die Treffer; pro Update wird per dispatchEvent ein lokales Browser-Event ausgeloest, das die HTML-Find-Bar ohne Round-Trip ueber C# aktualisiert.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Vor dem Merge unbedingt manueller Smoke mit einer 100KB+ Datei (Bug-A-Regression-Schutz).

---

### Aufgabe 098: Editor-Toolbar Hotkeys

**Status:** abgeschlossen
**Prioritaet:** hoch
**Erstellt:** 2026-02-14
**Verantwortlich:** Team Folio

#### Beschreibung

Light- und Dark-Mode tauschen die App-Theme-Resources aus. Editor-Farben werden ueber CSS-Custom-Properties gesteuert; ein Compartment-Reconfigure triggert Repaint im CodeMirror, falls wir spaeter modusabhaengige Anpassungen brauchen.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Achtung: Reihenfolge der DispatchJs-Calls vs. PostMessage ist nicht garantiert symmetrisch — das gehoert in die Doku.

---

### Aufgabe 099: Markdown-Pipeline GFM-Extensions

**Status:** blockiert
**Prioritaet:** kritisch
**Erstellt:** 2026-03-15
**Verantwortlich:** Architektur-Runde

#### Beschreibung

Beim Resize aendert sich die Editor-Hoehe und damit die Y-Positionen der Marker. Der updateListener im CodeMirror fuegt einen geometryChanged-Pfad ein, der die Marker-Lane neu zeichnet (Y proportional zur Line-Position).

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Tests: dotnet test, plus Custom-Smoke ueber die Automation-API (/state, /click, /save).

---

### Aufgabe 100: WebView2-Bridge-Channel registrieren

**Status:** geplant
**Prioritaet:** niedrig
**Erstellt:** 2026-04-16
**Verantwortlich:** Ralf K.

#### Beschreibung

Der bestehende Pfad ueber ExecuteScriptAsync skaliert nicht fuer Payloads ueber rund 150 KB. WebView2 truncated den Skript-String stillschweigend, was zu einem JavaScript-Syntax-Fehler oder zu einem Aufruf mit undefined-Argumenten fuehrt. Loesung: PostMessage-Kanal nutzen, der ein eigenes IPC-Protokoll mit groesseren Payloads erlaubt.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Branch-Name: feature/<task-key>. PR mit Screenshots vom View- und Edit-Modus.

---

### Aufgabe 101: Find-Bar Counter aktualisieren

**Status:** in Bearbeitung
**Prioritaet:** mittel
**Erstellt:** 2026-05-17
**Verantwortlich:** Claude

#### Beschreibung

Der Counter (X/Y) muss live mit dem aktuellen Treffer und der Gesamttreffer-Zahl synchronisiert sein. SearchCursor liefert die Treffer; pro Update wird per dispatchEvent ein lokales Browser-Event ausgeloest, das die HTML-Find-Bar ohne Round-Trip ueber C# aktualisiert.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Vor dem Merge unbedingt manueller Smoke mit einer 100KB+ Datei (Bug-A-Regression-Schutz).

---

### Aufgabe 102: Theme-Sync zwischen Shell und Editor

**Status:** Review
**Prioritaet:** hoch
**Erstellt:** 2026-06-18
**Verantwortlich:** Team Folio

#### Beschreibung

Light- und Dark-Mode tauschen die App-Theme-Resources aus. Editor-Farben werden ueber CSS-Custom-Properties gesteuert; ein Compartment-Reconfigure triggert Repaint im CodeMirror, falls wir spaeter modusabhaengige Anpassungen brauchen.

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Achtung: Reihenfolge der DispatchJs-Calls vs. PostMessage ist nicht garantiert symmetrisch — das gehoert in die Doku.

---

### Aufgabe 103: Marker-Lane bei Window-Resize neu rendern

**Status:** abgeschlossen
**Prioritaet:** kritisch
**Erstellt:** 2026-07-19
**Verantwortlich:** Architektur-Runde

#### Beschreibung

Beim Resize aendert sich die Editor-Hoehe und damit die Y-Positionen der Marker. Der updateListener im CodeMirror fuegt einen geometryChanged-Pfad ein, der die Marker-Lane neu zeichnet (Y proportional zur Line-Position).

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Tests: dotnet test, plus Custom-Smoke ueber die Automation-API (/state, /click, /save).

---

### Aufgabe 104: Vault-Tree expand-state persistieren

**Status:** blockiert
**Prioritaet:** niedrig
**Erstellt:** 2026-08-20
**Verantwortlich:** Ralf K.

#### Beschreibung

Der bestehende Pfad ueber ExecuteScriptAsync skaliert nicht fuer Payloads ueber rund 150 KB. WebView2 truncated den Skript-String stillschweigend, was zu einem JavaScript-Syntax-Fehler oder zu einem Aufruf mit undefined-Argumenten fuehrt. Loesung: PostMessage-Kanal nutzen, der ein eigenes IPC-Protokoll mit groesseren Payloads erlaubt.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Branch-Name: feature/<task-key>. PR mit Screenshots vom View- und Edit-Modus.

---

### Aufgabe 105: Cheat-Sheet-Drag-Position clampen

**Status:** geplant
**Prioritaet:** mittel
**Erstellt:** 2026-09-21
**Verantwortlich:** Claude

#### Beschreibung

Der Counter (X/Y) muss live mit dem aktuellen Treffer und der Gesamttreffer-Zahl synchronisiert sein. SearchCursor liefert die Treffer; pro Update wird per dispatchEvent ein lokales Browser-Event ausgeloest, das die HTML-Find-Bar ohne Round-Trip ueber C# aktualisiert.

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Vor dem Merge unbedingt manueller Smoke mit einer 100KB+ Datei (Bug-A-Regression-Schutz).

---

### Aufgabe 106: TOC-Highlight bei Scroll

**Status:** in Bearbeitung
**Prioritaet:** hoch
**Erstellt:** 2026-10-22
**Verantwortlich:** Team Folio

#### Beschreibung

Light- und Dark-Mode tauschen die App-Theme-Resources aus. Editor-Farben werden ueber CSS-Custom-Properties gesteuert; ein Compartment-Reconfigure triggert Repaint im CodeMirror, falls wir spaeter modusabhaengige Anpassungen brauchen.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Achtung: Reihenfolge der DispatchJs-Calls vs. PostMessage ist nicht garantiert symmetrisch — das gehoert in die Doku.

---

### Aufgabe 107: External-Change Save-Conflict-Prompt

**Status:** Review
**Prioritaet:** kritisch
**Erstellt:** 2026-11-23
**Verantwortlich:** Architektur-Runde

#### Beschreibung

Beim Resize aendert sich die Editor-Hoehe und damit die Y-Positionen der Marker. Der updateListener im CodeMirror fuegt einen geometryChanged-Pfad ein, der die Marker-Lane neu zeichnet (Y proportional zur Line-Position).

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Tests: dotnet test, plus Custom-Smoke ueber die Automation-API (/state, /click, /save).

---

### Aufgabe 108: Editor-Toolbar Hotkeys

**Status:** abgeschlossen
**Prioritaet:** niedrig
**Erstellt:** 2026-12-24
**Verantwortlich:** Ralf K.

#### Beschreibung

Der bestehende Pfad ueber ExecuteScriptAsync skaliert nicht fuer Payloads ueber rund 150 KB. WebView2 truncated den Skript-String stillschweigend, was zu einem JavaScript-Syntax-Fehler oder zu einem Aufruf mit undefined-Argumenten fuehrt. Loesung: PostMessage-Kanal nutzen, der ein eigenes IPC-Protokoll mit groesseren Payloads erlaubt.

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Branch-Name: feature/<task-key>. PR mit Screenshots vom View- und Edit-Modus.

---

### Aufgabe 109: Markdown-Pipeline GFM-Extensions

**Status:** blockiert
**Prioritaet:** mittel
**Erstellt:** 2026-01-25
**Verantwortlich:** Claude

#### Beschreibung

Der Counter (X/Y) muss live mit dem aktuellen Treffer und der Gesamttreffer-Zahl synchronisiert sein. SearchCursor liefert die Treffer; pro Update wird per dispatchEvent ein lokales Browser-Event ausgeloest, das die HTML-Find-Bar ohne Round-Trip ueber C# aktualisiert.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Vor dem Merge unbedingt manueller Smoke mit einer 100KB+ Datei (Bug-A-Regression-Schutz).

---

### Aufgabe 110: WebView2-Bridge-Channel registrieren

**Status:** geplant
**Prioritaet:** hoch
**Erstellt:** 2026-02-26
**Verantwortlich:** Team Folio

#### Beschreibung

Light- und Dark-Mode tauschen die App-Theme-Resources aus. Editor-Farben werden ueber CSS-Custom-Properties gesteuert; ein Compartment-Reconfigure triggert Repaint im CodeMirror, falls wir spaeter modusabhaengige Anpassungen brauchen.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Achtung: Reihenfolge der DispatchJs-Calls vs. PostMessage ist nicht garantiert symmetrisch — das gehoert in die Doku.

---

### Aufgabe 111: Find-Bar Counter aktualisieren

**Status:** in Bearbeitung
**Prioritaet:** kritisch
**Erstellt:** 2026-03-27
**Verantwortlich:** Architektur-Runde

#### Beschreibung

Beim Resize aendert sich die Editor-Hoehe und damit die Y-Positionen der Marker. Der updateListener im CodeMirror fuegt einen geometryChanged-Pfad ein, der die Marker-Lane neu zeichnet (Y proportional zur Line-Position).

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Tests: dotnet test, plus Custom-Smoke ueber die Automation-API (/state, /click, /save).

---

### Aufgabe 112: Theme-Sync zwischen Shell und Editor

**Status:** Review
**Prioritaet:** niedrig
**Erstellt:** 2026-04-28
**Verantwortlich:** Ralf K.

#### Beschreibung

Der bestehende Pfad ueber ExecuteScriptAsync skaliert nicht fuer Payloads ueber rund 150 KB. WebView2 truncated den Skript-String stillschweigend, was zu einem JavaScript-Syntax-Fehler oder zu einem Aufruf mit undefined-Argumenten fuehrt. Loesung: PostMessage-Kanal nutzen, der ein eigenes IPC-Protokoll mit groesseren Payloads erlaubt.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Branch-Name: feature/<task-key>. PR mit Screenshots vom View- und Edit-Modus.

---

### Aufgabe 113: Marker-Lane bei Window-Resize neu rendern

**Status:** abgeschlossen
**Prioritaet:** mittel
**Erstellt:** 2026-05-01
**Verantwortlich:** Claude

#### Beschreibung

Der Counter (X/Y) muss live mit dem aktuellen Treffer und der Gesamttreffer-Zahl synchronisiert sein. SearchCursor liefert die Treffer; pro Update wird per dispatchEvent ein lokales Browser-Event ausgeloest, das die HTML-Find-Bar ohne Round-Trip ueber C# aktualisiert.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Vor dem Merge unbedingt manueller Smoke mit einer 100KB+ Datei (Bug-A-Regression-Schutz).

---

### Aufgabe 114: Vault-Tree expand-state persistieren

**Status:** blockiert
**Prioritaet:** hoch
**Erstellt:** 2026-06-02
**Verantwortlich:** Team Folio

#### Beschreibung

Light- und Dark-Mode tauschen die App-Theme-Resources aus. Editor-Farben werden ueber CSS-Custom-Properties gesteuert; ein Compartment-Reconfigure triggert Repaint im CodeMirror, falls wir spaeter modusabhaengige Anpassungen brauchen.

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Achtung: Reihenfolge der DispatchJs-Calls vs. PostMessage ist nicht garantiert symmetrisch — das gehoert in die Doku.

---

### Aufgabe 115: Cheat-Sheet-Drag-Position clampen

**Status:** geplant
**Prioritaet:** kritisch
**Erstellt:** 2026-07-03
**Verantwortlich:** Architektur-Runde

#### Beschreibung

Beim Resize aendert sich die Editor-Hoehe und damit die Y-Positionen der Marker. Der updateListener im CodeMirror fuegt einen geometryChanged-Pfad ein, der die Marker-Lane neu zeichnet (Y proportional zur Line-Position).

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Tests: dotnet test, plus Custom-Smoke ueber die Automation-API (/state, /click, /save).

---

### Aufgabe 116: TOC-Highlight bei Scroll

**Status:** in Bearbeitung
**Prioritaet:** niedrig
**Erstellt:** 2026-08-04
**Verantwortlich:** Ralf K.

#### Beschreibung

Der bestehende Pfad ueber ExecuteScriptAsync skaliert nicht fuer Payloads ueber rund 150 KB. WebView2 truncated den Skript-String stillschweigend, was zu einem JavaScript-Syntax-Fehler oder zu einem Aufruf mit undefined-Argumenten fuehrt. Loesung: PostMessage-Kanal nutzen, der ein eigenes IPC-Protokoll mit groesseren Payloads erlaubt.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Branch-Name: feature/<task-key>. PR mit Screenshots vom View- und Edit-Modus.

---

### Aufgabe 117: External-Change Save-Conflict-Prompt

**Status:** Review
**Prioritaet:** mittel
**Erstellt:** 2026-09-05
**Verantwortlich:** Claude

#### Beschreibung

Der Counter (X/Y) muss live mit dem aktuellen Treffer und der Gesamttreffer-Zahl synchronisiert sein. SearchCursor liefert die Treffer; pro Update wird per dispatchEvent ein lokales Browser-Event ausgeloest, das die HTML-Find-Bar ohne Round-Trip ueber C# aktualisiert.

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Vor dem Merge unbedingt manueller Smoke mit einer 100KB+ Datei (Bug-A-Regression-Schutz).

---

### Aufgabe 118: Editor-Toolbar Hotkeys

**Status:** abgeschlossen
**Prioritaet:** hoch
**Erstellt:** 2026-10-06
**Verantwortlich:** Team Folio

#### Beschreibung

Light- und Dark-Mode tauschen die App-Theme-Resources aus. Editor-Farben werden ueber CSS-Custom-Properties gesteuert; ein Compartment-Reconfigure triggert Repaint im CodeMirror, falls wir spaeter modusabhaengige Anpassungen brauchen.

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [x] Doku in CLAUDE.md ergaenzt

#### Notizen

Achtung: Reihenfolge der DispatchJs-Calls vs. PostMessage ist nicht garantiert symmetrisch — das gehoert in die Doku.

---

### Aufgabe 119: Markdown-Pipeline GFM-Extensions

**Status:** blockiert
**Prioritaet:** kritisch
**Erstellt:** 2026-11-07
**Verantwortlich:** Architektur-Runde

#### Beschreibung

Beim Resize aendert sich die Editor-Hoehe und damit die Y-Positionen der Marker. Der updateListener im CodeMirror fuegt einen geometryChanged-Pfad ein, der die Marker-Lane neu zeichnet (Y proportional zur Line-Position).

#### Akzeptanzkriterien

- [ ] Bridge-Channel registriert und im Smoketest verifiziert
- [x] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Tests: dotnet test, plus Custom-Smoke ueber die Automation-API (/state, /click, /save).

---

### Aufgabe 120: WebView2-Bridge-Channel registrieren

**Status:** geplant
**Prioritaet:** niedrig
**Erstellt:** 2026-12-08
**Verantwortlich:** Ralf K.

#### Beschreibung

Der bestehende Pfad ueber ExecuteScriptAsync skaliert nicht fuer Payloads ueber rund 150 KB. WebView2 truncated den Skript-String stillschweigend, was zu einem JavaScript-Syntax-Fehler oder zu einem Aufruf mit undefined-Argumenten fuehrt. Loesung: PostMessage-Kanal nutzen, der ein eigenes IPC-Protokoll mit groesseren Payloads erlaubt.

#### Akzeptanzkriterien

- [x] Bridge-Channel registriert und im Smoketest verifiziert
- [ ] Tests fuer den Erfolgs- und Fehlerpfad geschrieben
- [ ] Doku in CLAUDE.md ergaenzt

#### Notizen

Branch-Name: feature/<task-key>. PR mit Screenshots vom View- und Edit-Modus.

---

## Notizen-Pool

Als Schluss-Sektion ein paar lose Notizen mit absichtlich vielen Whitespace-
und Punctuation-Variationen, um Round-Trip-Encoding zu testen.

- Notiz 001: Beobachtung zur Editor-Performance bei Datei-Groesse 5 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 002: Beobachtung zur Editor-Performance bei Datei-Groesse 10 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 003: Beobachtung zur Editor-Performance bei Datei-Groesse 15 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 004: Beobachtung zur Editor-Performance bei Datei-Groesse 20 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 005: Beobachtung zur Editor-Performance bei Datei-Groesse 25 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 006: Beobachtung zur Editor-Performance bei Datei-Groesse 30 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 007: Beobachtung zur Editor-Performance bei Datei-Groesse 35 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 008: Beobachtung zur Editor-Performance bei Datei-Groesse 40 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 009: Beobachtung zur Editor-Performance bei Datei-Groesse 45 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 010: Beobachtung zur Editor-Performance bei Datei-Groesse 50 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 011: Beobachtung zur Editor-Performance bei Datei-Groesse 55 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 012: Beobachtung zur Editor-Performance bei Datei-Groesse 60 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 013: Beobachtung zur Editor-Performance bei Datei-Groesse 65 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 014: Beobachtung zur Editor-Performance bei Datei-Groesse 70 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 015: Beobachtung zur Editor-Performance bei Datei-Groesse 75 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 016: Beobachtung zur Editor-Performance bei Datei-Groesse 80 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 017: Beobachtung zur Editor-Performance bei Datei-Groesse 85 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 018: Beobachtung zur Editor-Performance bei Datei-Groesse 90 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 019: Beobachtung zur Editor-Performance bei Datei-Groesse 95 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 020: Beobachtung zur Editor-Performance bei Datei-Groesse 100 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 021: Beobachtung zur Editor-Performance bei Datei-Groesse 105 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 022: Beobachtung zur Editor-Performance bei Datei-Groesse 110 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 023: Beobachtung zur Editor-Performance bei Datei-Groesse 115 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 024: Beobachtung zur Editor-Performance bei Datei-Groesse 120 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 025: Beobachtung zur Editor-Performance bei Datei-Groesse 125 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 026: Beobachtung zur Editor-Performance bei Datei-Groesse 130 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 027: Beobachtung zur Editor-Performance bei Datei-Groesse 135 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 028: Beobachtung zur Editor-Performance bei Datei-Groesse 140 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 029: Beobachtung zur Editor-Performance bei Datei-Groesse 145 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 030: Beobachtung zur Editor-Performance bei Datei-Groesse 150 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 031: Beobachtung zur Editor-Performance bei Datei-Groesse 155 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 032: Beobachtung zur Editor-Performance bei Datei-Groesse 160 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 033: Beobachtung zur Editor-Performance bei Datei-Groesse 165 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 034: Beobachtung zur Editor-Performance bei Datei-Groesse 170 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 035: Beobachtung zur Editor-Performance bei Datei-Groesse 175 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 036: Beobachtung zur Editor-Performance bei Datei-Groesse 180 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 037: Beobachtung zur Editor-Performance bei Datei-Groesse 185 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 038: Beobachtung zur Editor-Performance bei Datei-Groesse 190 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 039: Beobachtung zur Editor-Performance bei Datei-Groesse 195 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 040: Beobachtung zur Editor-Performance bei Datei-Groesse 200 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 041: Beobachtung zur Editor-Performance bei Datei-Groesse 205 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 042: Beobachtung zur Editor-Performance bei Datei-Groesse 210 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 043: Beobachtung zur Editor-Performance bei Datei-Groesse 215 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 044: Beobachtung zur Editor-Performance bei Datei-Groesse 220 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 045: Beobachtung zur Editor-Performance bei Datei-Groesse 225 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 046: Beobachtung zur Editor-Performance bei Datei-Groesse 230 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 047: Beobachtung zur Editor-Performance bei Datei-Groesse 235 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 048: Beobachtung zur Editor-Performance bei Datei-Groesse 240 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 049: Beobachtung zur Editor-Performance bei Datei-Groesse 245 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 050: Beobachtung zur Editor-Performance bei Datei-Groesse 250 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 051: Beobachtung zur Editor-Performance bei Datei-Groesse 255 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 052: Beobachtung zur Editor-Performance bei Datei-Groesse 260 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 053: Beobachtung zur Editor-Performance bei Datei-Groesse 265 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 054: Beobachtung zur Editor-Performance bei Datei-Groesse 270 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 055: Beobachtung zur Editor-Performance bei Datei-Groesse 275 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 056: Beobachtung zur Editor-Performance bei Datei-Groesse 280 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 057: Beobachtung zur Editor-Performance bei Datei-Groesse 285 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 058: Beobachtung zur Editor-Performance bei Datei-Groesse 290 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 059: Beobachtung zur Editor-Performance bei Datei-Groesse 295 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 060: Beobachtung zur Editor-Performance bei Datei-Groesse 300 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 061: Beobachtung zur Editor-Performance bei Datei-Groesse 305 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 062: Beobachtung zur Editor-Performance bei Datei-Groesse 310 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 063: Beobachtung zur Editor-Performance bei Datei-Groesse 315 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 064: Beobachtung zur Editor-Performance bei Datei-Groesse 320 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 065: Beobachtung zur Editor-Performance bei Datei-Groesse 325 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 066: Beobachtung zur Editor-Performance bei Datei-Groesse 330 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 067: Beobachtung zur Editor-Performance bei Datei-Groesse 335 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 068: Beobachtung zur Editor-Performance bei Datei-Groesse 340 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 069: Beobachtung zur Editor-Performance bei Datei-Groesse 345 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 070: Beobachtung zur Editor-Performance bei Datei-Groesse 350 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 071: Beobachtung zur Editor-Performance bei Datei-Groesse 355 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 072: Beobachtung zur Editor-Performance bei Datei-Groesse 360 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 073: Beobachtung zur Editor-Performance bei Datei-Groesse 365 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 074: Beobachtung zur Editor-Performance bei Datei-Groesse 370 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 075: Beobachtung zur Editor-Performance bei Datei-Groesse 375 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 076: Beobachtung zur Editor-Performance bei Datei-Groesse 380 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 077: Beobachtung zur Editor-Performance bei Datei-Groesse 385 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 078: Beobachtung zur Editor-Performance bei Datei-Groesse 390 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 079: Beobachtung zur Editor-Performance bei Datei-Groesse 395 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
- Notiz 080: Beobachtung zur Editor-Performance bei Datei-Groesse 400 KB.
  Folgemassnahme: Smoke mit --automation und Bytezahl-Check nach jedem Save.
