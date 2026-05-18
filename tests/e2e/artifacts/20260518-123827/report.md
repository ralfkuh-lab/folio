# E2E Run – 2026-05-18 12:38:27

- Dauer: **1.06s**
- Szenarien: **7** – 7 PASS, 0 FAIL
- Visuelle Vergleiche: **8** – 8 PASS, 0 FAIL
- Binary: `/root/projects/ralfkuh-lab/folio/src-tauri/target/release/folio`
- Folio-Konsole: [`console.log`](console.log)

## Szenarien

### ✅ PASS – `01_boot` (0.01s)

| # | Schritt | Status | Dauer | Detail |
|---:|---|:---:|---:|---|
| 1 | api alive | ✓ | 0.00s |  |
| 2 | default viewMode == view | ✓ | 0.00s |  |
| 3 | console.errors leer nach boot | ✓ | 0.00s |  |
| 4 | baseline screenshot (boot) | ✓ | 0.01s |  |


### ✅ PASS – `02_view_mode` (0.36s)

| # | Schritt | Status | Dauer | Detail |
|---:|---|:---:|---:|---|
| 1 | open sample.md | ✓ | 0.00s |  |
| 2 | state spiegelt Dokument | ✓ | 0.00s |  |
| 3 | TOC hat erwartete Eintraege | ✓ | 0.00s |  |
| 4 | screenshot default view | ✓ | 0.02s |  |
| 5 | anchor scroll zu Abschnitt B | ✓ | 0.32s |  |
| 6 | screenshot nach anchor jump | ✓ | 0.02s |  |


### ✅ PASS – `03_edit_mode` (0.20s)

| # | Schritt | Status | Dauer | Detail |
|---:|---|:---:|---:|---|
| 1 | open sample.md | ✓ | 0.01s |  |
| 2 | switch to edit mode | ✓ | 0.10s |  |
| 3 | state.editor.ready ist true | ✓ | 0.00s |  |
| 4 | editor text matches file content | ✓ | 0.00s |  |
| 5 | screenshot edit mode | ✓ | 0.01s |  |
| 6 | selection setzen auf Header | ✓ | 0.05s |  |
| 7 | zurueck in view mode | ✓ | 0.03s |  |


### ✅ PASS – `04_theme` (0.06s)

| # | Schritt | Status | Dauer | Detail |
|---:|---|:---:|---:|---|
| 1 | open sample.md | ✓ | 0.00s |  |
| 2 | force dark theme | ✓ | 0.00s |  |
| 3 | screenshot dark | ✓ | 0.03s |  |
| 4 | force light theme | ✓ | 0.00s |  |
| 5 | screenshot light | ✓ | 0.02s |  |
| 6 | back to dark | ✓ | 0.01s |  |


### ✅ PASS – `05_vault` (0.03s)

| # | Schritt | Status | Dauer | Detail |
|---:|---|:---:|---:|---|
| 1 | rails sichtbar nach boot | ✓ | 0.00s |  |
| 2 | left rail toggle off | ✓ | 0.00s |  |
| 3 | left rail toggle on | ✓ | 0.00s |  |
| 4 | screenshot rails-visible | ✓ | 0.03s |  |


### ✅ PASS – `06_find` (0.39s)

| # | Schritt | Status | Dauer | Detail |
|---:|---|:---:|---:|---|
| 1 | open sample.md + edit mode | ✓ | 0.06s |  |
| 2 | find-bar oeffnen | ✓ | 0.00s |  |
| 3 | find-term setzen 'Abschnitt' | ✓ | 0.30s |  |
| 4 | screenshot find-bar offen | ✓ | 0.01s |  |
| 5 | find-bar schliessen via Escape | ✓ | 0.01s |  |


### ✅ PASS – `07_workspace` (0.01s)

| # | Schritt | Status | Dauer | Detail |
|---:|---|:---:|---:|---|
| 1 | open sample.md | ✓ | 0.00s |  |
| 2 | workspace.recent enthaelt sample.md | ✓ | 0.01s |  |


## Visuelle Vergleiche

| Name | Status | Mismatch | Threshold | Diff |
|---|:---:|---:|---:|---|
| `01_boot__boot_initial` | ✓ | 0.0000% | 1.00% | — |
| `02_view_mode__view_default` | ✓ | 0.0000% | 1.00% | — |
| `02_view_mode__view_anchor_b` | ✓ | 0.0000% | 1.00% | — |
| `03_edit_mode__edit_default` | ✓ | 0.0000% | 1.00% | — |
| `04_theme__theme_dark` | ✓ | 0.0000% | 1.00% | — |
| `04_theme__theme_light` | ✓ | 0.0000% | 1.00% | — |
| `05_vault__vault_rails_visible` | ✓ | 0.0000% | 1.00% | — |
| `06_find__find_open_abschnitt` | ✓ | 0.0000% | 1.00% | — |
