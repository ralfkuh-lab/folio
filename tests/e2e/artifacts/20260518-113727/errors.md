# E2E Fehler – 2026-05-18 11:37:27

1 Szenario(s) gefailt.

## ❌ `02_view_mode`

**Fehler:** HTTP 400: Failed to deserialize the JSON body into the target type: missing field `slug` at line 1 column 25

Gefailter Schritt:
- `anchor scroll zu Abschnitt B` (0.01s) – HTTP 400: Failed to deserialize the JSON body into the target type: missing field `slug` at line 1 column 25

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
