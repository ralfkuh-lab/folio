# E2E Run – 2026-05-18 11:37:27

- Dauer: **1.78s**
- Szenarien: **7** – 6 PASS, 1 FAIL
- Visuelle Vergleiche: **7** – 7 PASS, 0 FAIL
- Binary: `/root/projects/ralfkuh-lab/folio/src-tauri/target/release/folio`
- Folio-Konsole: [`console.log`](console.log)

## Szenarien

### ✅ PASS – `01_boot` (0.03s)

| # | Schritt | Status | Dauer | Detail |
|---:|---|:---:|---:|---|
| 1 | api alive | ✓ | 0.00s |  |
| 2 | default viewMode == view | ✓ | 0.00s |  |
| 3 | console.errors leer nach boot | ✓ | 0.00s |  |
| 4 | baseline screenshot (boot) | ✓ | 0.02s |  |


### ❌ FAIL – `02_view_mode` (0.06s)

| # | Schritt | Status | Dauer | Detail |
|---:|---|:---:|---:|---|
| 1 | open sample.md | ✓ | 0.00s |  |
| 2 | state spiegelt Dokument | ✓ | 0.00s |  |
| 3 | TOC hat erwartete Eintraege | ✓ | 0.00s |  |
| 4 | screenshot default view | ✓ | 0.04s |  |
| 5 | anchor scroll zu Abschnitt B | ✗ | 0.01s | HTTP 400: Failed to deserialize the JSON body into the target type: missing field `slug` at line 1 column 25 |

**Fehler:**

```
HTTP 400: Failed to deserialize the JSON body into the target type: missing field `slug` at line 1 column 25
```

<details><summary>Traceback</summary>

```
Traceback (most recent call last):
  File "/root/projects/ralfkuh-lab/folio/tests/e2e/lib/api.py", line 47, in _request
    with urllib.request.urlopen(req, timeout=timeout or self.timeout) as resp:
         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/root/.local/share/uv/python/cpython-3.11.15-linux-x86_64-gnu/lib/python3.11/urllib/request.py", line 216, in urlopen
    return opener.open(url, data, timeout)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/root/.local/share/uv/python/cpython-3.11.15-linux-x86_64-gnu/lib/python3.11/urllib/request.py", line 525, in open
    response = meth(req, response)
               ^^^^^^^^^^^^^^^^^^^
  File "/root/.local/share/uv/python/cpython-3.11.15-linux-x86_64-gnu/lib/python3.11/urllib/request.py", line 634, in http_response
    response = self.parent.error(
               ^^^^^^^^^^^^^^^^^^
  File "/root/.local/share/uv/python/cpython-3.11.15-linux-x86_64-gnu/lib/python3.11/urllib/request.py", line 563, in error
    return self._call_chain(*args)
           ^^^^^^^^^^^^^^^^^^^^^^^
  File "/root/.local/share/uv/python/cpython-3.11.15-linux-x86_64-gnu/lib/python3.11/urllib/request.py", line 496, in _call_chain
    result = func(*args)
             ^^^^^^^^^^^
  File "/root/.local/share/uv/python/cpython-3.11.15-linux-x86_64-gnu/lib/python3.11/urllib/request.py", line 643, in http_error_default
    raise HTTPError(req.full_url, code, msg, hdrs, fp)
urllib.error.HTTPError: HTTP Error 400: Bad Request

During handling of the above exception, another exception occurred:

Traceback (most recent call last):
  File "/root/projects/ralfkuh-lab/folio/tests/e2e/lib/report.py", line 81, in step
    yield
  File "/root/projects/ralfkuh-lab/folio/tests/e2e/scenarios/02_view_mode.py", line 49, in run
    ctx.api.toc_activate("abschnitt-b")
  File "/root/projects/ralfkuh-lab/folio/tests/e2e/lib/api.py", line 128, in toc_activate
    return self._request("POST", "/toc/activate", {"anchor": anchor})
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/root/projects/ralfkuh-lab/folio/tests/e2e/lib/api.py", line 57, in _request
    raise ApiError(e.code, msg)
lib.api.ApiError: HTTP 400: Failed to deserialize the JSON body into the target type: missing field `slug` at line 1 column 25
```

</details>


### ✅ PASS – `03_edit_mode` (0.68s)

| # | Schritt | Status | Dauer | Detail |
|---:|---|:---:|---:|---|
| 1 | open sample.md | ✓ | 0.01s |  |
| 2 | switch to edit mode | ✓ | 0.49s |  |
| 3 | state.editor.ready ist true | ✓ | 0.00s |  |
| 4 | editor text matches file content | ✓ | 0.00s |  |
| 5 | screenshot edit mode | ✓ | 0.02s |  |
| 6 | selection setzen auf Header | ✓ | 0.10s |  |
| 7 | zurueck in view mode | ✓ | 0.06s |  |


### ✅ PASS – `04_theme` (0.12s)

| # | Schritt | Status | Dauer | Detail |
|---:|---|:---:|---:|---|
| 1 | open sample.md | ✓ | 0.01s |  |
| 2 | force dark theme | ✓ | 0.01s |  |
| 3 | screenshot dark | ✓ | 0.05s |  |
| 4 | force light theme | ✓ | 0.01s |  |
| 5 | screenshot light | ✓ | 0.04s |  |
| 6 | back to dark | ✓ | 0.00s |  |


### ✅ PASS – `05_vault` (0.04s)

| # | Schritt | Status | Dauer | Detail |
|---:|---|:---:|---:|---|
| 1 | rails sichtbar nach boot | ✓ | 0.00s |  |
| 2 | left rail toggle off | ✓ | 0.00s |  |
| 3 | left rail toggle on | ✓ | 0.00s |  |
| 4 | screenshot rails-visible | ✓ | 0.04s |  |


### ✅ PASS – `06_find` (0.85s)

| # | Schritt | Status | Dauer | Detail |
|---:|---|:---:|---:|---|
| 1 | open sample.md + edit mode | ✓ | 0.05s |  |
| 2 | find-bar oeffnen | ✓ | 0.00s |  |
| 3 | find-term setzen 'Abschnitt' | ✓ | 0.30s |  |
| 4 | screenshot find-bar offen | ✓ | 0.01s |  |
| 5 | find-bar schliessen via Escape | ✓ | 0.48s |  |


### ✅ PASS – `07_workspace` (0.01s)

| # | Schritt | Status | Dauer | Detail |
|---:|---|:---:|---:|---|
| 1 | open sample.md | ✓ | 0.00s |  |
| 2 | workspace.recent enthaelt sample.md | ✓ | 0.00s |  |


## Visuelle Vergleiche

| Name | Status | Mismatch | Threshold | Diff |
|---|:---:|---:|---:|---|
| `01_boot__boot_initial` | ✓ | 0.0000% | 1.00% | — |
| `02_view_mode__view_default` | ✓ | 0.0000% | 1.00% | — |
| `03_edit_mode__edit_default` | ✓ | 0.0000% | 1.00% | — |
| `04_theme__theme_dark` | ✓ | 0.0000% | 1.00% | — |
| `04_theme__theme_light` | ✓ | 0.0000% | 1.00% | — |
| `05_vault__vault_rails_visible` | ✓ | 0.0000% | 1.00% | — |
| `06_find__find_open_abschnitt` | ✓ | 0.0000% | 1.00% | — |
