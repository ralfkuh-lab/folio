# Folio — Rauchtest

Diese Datei dient zum manuellen Smoketest.

## Links zum Testen

- [Entscheidungsgrundlage](../markdown-viewer-entscheidung.md) — sollte navigieren und diese andere `.md`-Datei rendern.
- [Mit Anker](../markdown-viewer-entscheidung.md#empfehlung) — sollte navigieren und zum Abschnitt „Empfehlung" scrollen.
- [Anker auf diese Datei](#abschnitt-b) — sollte nur scrollen, nicht navigieren.
- [GitHub Repo](https://github.com/ralfkuh-lab/folio) — sollte im Standardbrowser öffnen, nicht im Viewer.

## Typografie

**Fett**, *kursiv*, ~~durchgestrichen~~, `inline code`.

> Blockzitat mit einem kurzen Satz.

### Codeblock

```csharp
public sealed class NavigationController
{
    public bool CanGoBack => _currentIndex > 0;
}
```

### Tabelle

| Modus | Shortcut |
|---|---|
| View | Ctrl+1 |
| Edit | Ctrl+2 |
| Split | Ctrl+3 |

### Tasklist

- [x] View-Modus funktioniert
- [ ] Edit-Modus (Phase 2)
- [ ] Split-Modus (Phase 3)

## Abschnitt B

Zieltext für den Anker-Link oben.

Zurück über `Alt+←` oder Maustaste 4.
