# E2E Fehler – 2026-05-18 11:38:16

6 Szenario(s) gefailt.

## ❌ `01_boot`

**Fehler:** visual diff failed: mismatch 90.8002% (threshold 1.00%)

Gefailter Schritt:
- `baseline screenshot (boot)` (0.09s) – visual diff failed: mismatch 90.8002% (threshold 1.00%)

```
Traceback (most recent call last):
  File "/root/projects/ralfkuh-lab/folio/tests/e2e/lib/report.py", line 81, in step
    yield
  File "/root/projects/ralfkuh-lab/folio/tests/e2e/scenarios/01_boot.py", line 29, in run
    ctx.screenshot("boot_initial")
  File "/root/projects/ralfkuh-lab/folio/tests/e2e/lib/report.py", line 118, in screenshot
    raise AssertionError(f"visual diff failed: {result.message}")
AssertionError: visual diff failed: mismatch 90.8002% (threshold 1.00%)
```

## ❌ `02_view_mode`

**Fehler:** visual diff failed: mismatch 90.8002% (threshold 1.00%)

Gefailter Schritt:
- `screenshot default view` (0.08s) – visual diff failed: mismatch 90.8002% (threshold 1.00%)

```
Traceback (most recent call last):
  File "/root/projects/ralfkuh-lab/folio/tests/e2e/lib/report.py", line 81, in step
    yield
  File "/root/projects/ralfkuh-lab/folio/tests/e2e/scenarios/02_view_mode.py", line 45, in run
    ctx.screenshot("view_default")
  File "/root/projects/ralfkuh-lab/folio/tests/e2e/lib/report.py", line 118, in screenshot
    raise AssertionError(f"visual diff failed: {result.message}")
AssertionError: visual diff failed: mismatch 90.8002% (threshold 1.00%)
```

## ❌ `03_edit_mode`

**Fehler:** visual diff failed: mismatch 90.6580% (threshold 1.00%)

Gefailter Schritt:
- `screenshot edit mode` (0.13s) – visual diff failed: mismatch 90.6580% (threshold 1.00%)

```
Traceback (most recent call last):
  File "/root/projects/ralfkuh-lab/folio/tests/e2e/lib/report.py", line 81, in step
    yield
  File "/root/projects/ralfkuh-lab/folio/tests/e2e/scenarios/03_edit_mode.py", line 35, in run
    ctx.screenshot("edit_default")
  File "/root/projects/ralfkuh-lab/folio/tests/e2e/lib/report.py", line 118, in screenshot
    raise AssertionError(f"visual diff failed: {result.message}")
AssertionError: visual diff failed: mismatch 90.6580% (threshold 1.00%)
```

## ❌ `04_theme`

**Fehler:** visual diff failed: mismatch 90.5699% (threshold 1.00%)

Gefailter Schritt:
- `screenshot dark` (0.12s) – visual diff failed: mismatch 90.5699% (threshold 1.00%)

```
Traceback (most recent call last):
  File "/root/projects/ralfkuh-lab/folio/tests/e2e/lib/report.py", line 81, in step
    yield
  File "/root/projects/ralfkuh-lab/folio/tests/e2e/scenarios/04_theme.py", line 19, in run
    ctx.screenshot("theme_dark")
  File "/root/projects/ralfkuh-lab/folio/tests/e2e/lib/report.py", line 118, in screenshot
    raise AssertionError(f"visual diff failed: {result.message}")
AssertionError: visual diff failed: mismatch 90.5699% (threshold 1.00%)
```

## ❌ `05_vault`

**Fehler:** visual diff failed: mismatch 90.0246% (threshold 1.00%)

Gefailter Schritt:
- `screenshot rails-visible` (0.10s) – visual diff failed: mismatch 90.0246% (threshold 1.00%)

```
Traceback (most recent call last):
  File "/root/projects/ralfkuh-lab/folio/tests/e2e/lib/report.py", line 81, in step
    yield
  File "/root/projects/ralfkuh-lab/folio/tests/e2e/scenarios/05_vault.py", line 37, in run
    ctx.screenshot("vault_rails_visible")
  File "/root/projects/ralfkuh-lab/folio/tests/e2e/lib/report.py", line 118, in screenshot
    raise AssertionError(f"visual diff failed: {result.message}")
AssertionError: visual diff failed: mismatch 90.0246% (threshold 1.00%)
```

## ❌ `06_find`

**Fehler:** visual diff failed: mismatch 1.1075% (threshold 1.00%)

Gefailter Schritt:
- `screenshot find-bar offen` (0.10s) – visual diff failed: mismatch 1.1075% (threshold 1.00%)

```
Traceback (most recent call last):
  File "/root/projects/ralfkuh-lab/folio/tests/e2e/lib/report.py", line 81, in step
    yield
  File "/root/projects/ralfkuh-lab/folio/tests/e2e/scenarios/06_find.py", line 27, in run
    ctx.screenshot("find_open_abschnitt")
  File "/root/projects/ralfkuh-lab/folio/tests/e2e/lib/report.py", line 118, in screenshot
    raise AssertionError(f"visual diff failed: {result.message}")
AssertionError: visual diff failed: mismatch 1.1075% (threshold 1.00%)
```

## Visuelle Diffs

- `01_boot__boot_initial`: mismatch 90.8002% (threshold 1.00%) – diff: 01_boot__boot_initial.png
- `02_view_mode__view_default`: mismatch 90.8002% (threshold 1.00%) – diff: 02_view_mode__view_default.png
- `03_edit_mode__edit_default`: mismatch 90.6580% (threshold 1.00%) – diff: 03_edit_mode__edit_default.png
- `04_theme__theme_dark`: mismatch 90.5699% (threshold 1.00%) – diff: 04_theme__theme_dark.png
- `05_vault__vault_rails_visible`: mismatch 90.0246% (threshold 1.00%) – diff: 05_vault__vault_rails_visible.png
- `06_find__find_open_abschnitt`: mismatch 1.1075% (threshold 1.00%) – diff: 06_find__find_open_abschnitt.png
