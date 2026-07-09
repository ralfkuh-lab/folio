# Mermaid-Diagramme

Testdokument für die Mermaid-Unterstützung. Jeder Block unten ist ein
```` ```mermaid ````-Fence und soll als Diagramm gerendert werden —
nicht als Code-Block.

## Flowchart

```mermaid
flowchart LR
    A[Dokument öffnen] --> B{Markdown?}
    B -- ja --> C[comrak rendert HTML]
    B -- nein --> D[Code-View]
    C --> E[Mermaid-Blöcke rendern]
    E --> F((fertig))
```

## Sequenzdiagramm

```mermaid
sequenceDiagram
    participant U as User
    participant F as Frontend
    participant B as Backend
    U->>F: Datei öffnen
    F->>B: read_file
    B-->>F: document:loaded (HTML)
    F->>F: renderMermaidBlocks()
    F-->>U: Diagramm sichtbar
```

## Klassendiagramm

```mermaid
classDiagram
    class DocumentStore {
        +path: PathBuf
        +dirty: bool
        +load()
        +save()
    }
    class TabManager {
        +tabs: Vec~Tab~
        +active: usize
    }
    TabManager "1" --> "*" DocumentStore : verwaltet
```

## Zustandsdiagramm

```mermaid
stateDiagram-v2
    [*] --> View
    View --> Edit : Ctrl+2
    Edit --> View : Ctrl+1
    View --> Split : Ctrl+3
    Split --> View : Ctrl+1
    Edit --> [*] : Ctrl+W
```

## Gantt

```mermaid
gantt
    title Feature-Etappen
    dateFormat YYYY-MM-DD
    section Umsetzung
    Spec           :done,    s1, 2026-07-09, 1d
    Implementierung:active,  s2, after s1, 2d
    E2E + Review   :         s3, after s2, 1d
```

## Kuchendiagramm

```mermaid
pie title Delegation
    "grok" : 55
    "codex" : 25
    "agy" : 15
    "selbst" : 5
```

## Fehlerfall (absichtlich kaputt)

Der folgende Block enthält ungültige Mermaid-Syntax und soll eine
Fehlermeldung bzw. den Quelltext zeigen — aber nicht die App zerlegen:

```mermaid
flowchart LR
    A --> ???[
```

## Normaler Code-Block (Gegenprobe)

Dieser Block darf **nicht** als Diagramm gerendert werden:

```rust
fn main() {
    println!("kein Diagramm");
}
```
