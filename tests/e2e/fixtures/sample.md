# Folio E2E Fixture

Diese Datei dient als deterministisches Test-Dokument für die E2E-Suite.
Inhalt ist absichtlich knapp und stabil — Änderungen hier brechen
Visual-Baselines.

## Abschnitt A

Ein erster Inhalts-Block mit **fettem** und _kursivem_ Text und einem
[Beispiel-Link](#abschnitt-b).

## Abschnitt B

- Listenpunkt eins
- Listenpunkt zwei
- Listenpunkt drei

```python
def hello(name: str) -> str:
    return f"Hello, {name}!"
```

## Abschnitt C

> Ein Zitat als Block.

| Spalte 1 | Spalte 2 |
|---|---|
| Wert A   | Wert B   |
| Wert C   | Wert D   |

## Schlussabschnitt

Ende der Test-Fixture.
