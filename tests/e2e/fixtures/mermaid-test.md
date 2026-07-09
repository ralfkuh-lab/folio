# Mermaid E2E Fixture

Nur fuer Szenario 42 (In-App) und 43 (Export). Flowchart + kaputter Block + Rust-Gegenprobe.

```mermaid
flowchart TD
    Start[Start] --> Entscheidung{ Markdown? }
    Entscheidung -->|ja| Render[Render]
    Entscheidung -->|nein| Code[Code-View]
    Render --> Ende((Ende))
```

Rust-Block muss als Code-Block bleiben:

```rust
fn main() {
    println!("kein mermaid");
}
```

Kaputter Block (fuer Export-Fallback-Test in 43):

```mermaid
flowchart LR
    A --> ???[
```
