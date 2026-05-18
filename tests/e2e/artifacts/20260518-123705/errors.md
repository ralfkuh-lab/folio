# E2E Fehler – 2026-05-18 12:37:05

1 Szenario(s) gefailt.

## ❌ `02_view_mode`

**Fehler:** expected scrollY > 0 after anchor jump, got 0.0

Gefailter Schritt:
- `scrollY > 0 nach anchor-jump` (2.02s) – expected scrollY > 0 after anchor jump, got 0.0

```
Traceback (most recent call last):
  File "/root/projects/ralfkuh-lab/folio/tests/e2e/lib/report.py", line 81, in step
    yield
  File "/root/projects/ralfkuh-lab/folio/tests/e2e/scenarios/02_view_mode.py", line 64, in run
    ctx.expect(
  File "/root/projects/ralfkuh-lab/folio/tests/e2e/lib/report.py", line 102, in expect
    raise AssertionError(message)
AssertionError: expected scrollY > 0 after anchor jump, got 0.0
```
