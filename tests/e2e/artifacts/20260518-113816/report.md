# E2E Run – 2026-05-18 11:38:16

- Dauer: **1.32s**
- Szenarien: **7** – 1 PASS, 6 FAIL
- Visuelle Vergleiche: **6** – 0 PASS, 6 FAIL
- Binary: `/root/projects/ralfkuh-lab/folio/src-tauri/target/release/folio`
- Folio-Konsole: [`console.log`](console.log)

## Szenarien

### ❌ FAIL – `01_boot` (0.09s)

| # | Schritt | Status | Dauer | Detail |
|---:|---|:---:|---:|---|
| 1 | api alive | ✓ | 0.00s |  |
| 2 | default viewMode == view | ✓ | 0.00s |  |
| 3 | console.errors leer nach boot | ✓ | 0.00s |  |
| 4 | baseline screenshot (boot) | ✗ | 0.09s | visual diff failed: mismatch 90.8002% (threshold 1.00%) |

**Fehler:**

```
visual diff failed: mismatch 90.8002% (threshold 1.00%)
```

<details><summary>Traceback</summary>

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

</details>


### ❌ FAIL – `02_view_mode` (0.08s)

| # | Schritt | Status | Dauer | Detail |
|---:|---|:---:|---:|---|
| 1 | open sample.md | ✓ | 0.00s |  |
| 2 | state spiegelt Dokument | ✓ | 0.00s |  |
| 3 | TOC hat erwartete Eintraege | ✓ | 0.00s |  |
| 4 | screenshot default view | ✗ | 0.08s | visual diff failed: mismatch 90.8002% (threshold 1.00%) |

**Fehler:**

```
visual diff failed: mismatch 90.8002% (threshold 1.00%)
```

<details><summary>Traceback</summary>

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

</details>


### ❌ FAIL – `03_edit_mode` (0.45s)

| # | Schritt | Status | Dauer | Detail |
|---:|---|:---:|---:|---|
| 1 | open sample.md | ✓ | 0.00s |  |
| 2 | switch to edit mode | ✓ | 0.31s |  |
| 3 | state.editor.ready ist true | ✓ | 0.00s |  |
| 4 | editor text matches file content | ✓ | 0.00s |  |
| 5 | screenshot edit mode | ✗ | 0.13s | visual diff failed: mismatch 90.6580% (threshold 1.00%) |

**Fehler:**

```
visual diff failed: mismatch 90.6580% (threshold 1.00%)
```

<details><summary>Traceback</summary>

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

</details>


### ❌ FAIL – `04_theme` (0.12s)

| # | Schritt | Status | Dauer | Detail |
|---:|---|:---:|---:|---|
| 1 | open sample.md | ✓ | 0.00s |  |
| 2 | force dark theme | ✓ | 0.00s |  |
| 3 | screenshot dark | ✗ | 0.12s | visual diff failed: mismatch 90.5699% (threshold 1.00%) |

**Fehler:**

```
visual diff failed: mismatch 90.5699% (threshold 1.00%)
```

<details><summary>Traceback</summary>

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

</details>


### ❌ FAIL – `05_vault` (0.11s)

| # | Schritt | Status | Dauer | Detail |
|---:|---|:---:|---:|---|
| 1 | rails sichtbar nach boot | ✓ | 0.00s |  |
| 2 | left rail toggle off | ✓ | 0.00s |  |
| 3 | left rail toggle on | ✓ | 0.00s |  |
| 4 | screenshot rails-visible | ✗ | 0.10s | visual diff failed: mismatch 90.0246% (threshold 1.00%) |

**Fehler:**

```
visual diff failed: mismatch 90.0246% (threshold 1.00%)
```

<details><summary>Traceback</summary>

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

</details>


### ❌ FAIL – `06_find` (0.44s)

| # | Schritt | Status | Dauer | Detail |
|---:|---|:---:|---:|---|
| 1 | open sample.md + edit mode | ✓ | 0.04s |  |
| 2 | find-bar oeffnen | ✓ | 0.00s |  |
| 3 | find-term setzen 'Abschnitt' | ✓ | 0.30s |  |
| 4 | screenshot find-bar offen | ✗ | 0.10s | visual diff failed: mismatch 1.1075% (threshold 1.00%) |

**Fehler:**

```
visual diff failed: mismatch 1.1075% (threshold 1.00%)
```

<details><summary>Traceback</summary>

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

</details>


### ✅ PASS – `07_workspace` (0.00s)

| # | Schritt | Status | Dauer | Detail |
|---:|---|:---:|---:|---|
| 1 | open sample.md | ✓ | 0.00s |  |
| 2 | workspace.recent enthaelt sample.md | ✓ | 0.00s |  |


## Visuelle Vergleiche

| Name | Status | Mismatch | Threshold | Diff |
|---|:---:|---:|---:|---|
| `01_boot__boot_initial` | ✗ | 90.8000% | 1.00% | [diff](01_boot__boot_initial.png) |
| `02_view_mode__view_default` | ✗ | 90.8000% | 1.00% | [diff](02_view_mode__view_default.png) |
| `03_edit_mode__edit_default` | ✗ | 90.6580% | 1.00% | [diff](03_edit_mode__edit_default.png) |
| `04_theme__theme_dark` | ✗ | 90.5700% | 1.00% | [diff](04_theme__theme_dark.png) |
| `05_vault__vault_rails_visible` | ✗ | 90.0250% | 1.00% | [diff](05_vault__vault_rails_visible.png) |
| `06_find__find_open_abschnitt` | ✗ | 1.1080% | 1.00% | [diff](06_find__find_open_abschnitt.png) |
