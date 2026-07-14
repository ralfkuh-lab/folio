"""Funktionaler UI-Test fuer KI-Anbieter und KI-Modelle.

Der Custom-Endpoint ist absichtlich unerreichbar. Das Szenario loest weder
Katalog-Refresh noch Modellabruf aus und fuehrt damit keine Netz-Calls aus.
"""

import time


PROVIDER_ID = "e2e-local-provider"
TEST_KEY = "e2e-password-only-key"


def _poll(ctx, predicate, timeout_s: float = 5.0):
    deadline = time.monotonic() + timeout_s
    value = None
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.05)
    return value


def _eval_value(ctx, js: str):
    response = ctx.api.eval(js)
    ctx.expect(response.get("ok") is True, f"/eval schlug fehl: {response!r}")
    return response.get("value")


def _settings_visible(ctx) -> bool:
    return bool(
        _eval_value(
            ctx,
            """(() => {
                const dialog = document.getElementById("settings-dialog");
                return !!dialog && !dialog.hidden;
            })()""",
        )
    )


def _custom_state(ctx) -> dict:
    return (
        _eval_value(
            ctx,
            f"""(() => {{
                const card = document.querySelector(
                    '#ai-provider-list [data-ai-provider-id="{PROVIDER_ID}"]'
                );
                const enabled = document.getElementById(
                    "ai-provider-enabled-{PROVIDER_ID}"
                );
                const auth = document.querySelector(
                    '[data-ai-auth-provider="{PROVIDER_ID}"]'
                );
                const key = document.getElementById("ai-auth-key-{PROVIDER_ID}");
                const remove = document.getElementById(
                    "ai-auth-remove-{PROVIDER_ID}"
                );
                const stored = auth && auth.querySelector(
                    ".settings-ai-status-dot--stored"
                );
                return {{
                    exists: !!card,
                    enabled: enabled ? enabled.checked : null,
                    keyType: key ? key.type : null,
                    keyValue: key ? key.value : null,
                    keyInMarkup: document.documentElement.outerHTML.includes(
                        {TEST_KEY!r}
                    ),
                    keyInText: document.body.textContent.includes({TEST_KEY!r}),
                    removeHidden: remove ? remove.hidden : null,
                    keyStored: !!stored
                }};
            }})()""",
        )
        or {}
    )


def _cleanup(ctx) -> None:
    # Direkter Fallback garantiert Isolation auch dann, wenn das Szenario vor
    # dem UI-Loeschschritt abbricht. Beide Commands sind idempotent.
    try:
        ctx.api.eval(
            f"""Promise.allSettled([
                window.__folioInvoke("ai_auth_remove", {{
                    providerId: "{PROVIDER_ID}"
                }}),
                window.__folioInvoke("ai_custom_delete", {{
                    id: "{PROVIDER_ID}"
                }})
            ])"""
        )
    except Exception:
        pass
    try:
        if _settings_visible(ctx):
            ctx.api.key("Escape")
    except Exception:
        pass


def run(ctx):
    try:
        with ctx.step("Settings im expliziten View-Mode oeffnen"):
            ctx.api.mode("view")
            if _settings_visible(ctx):
                ctx.api.key("Escape")
            ctx.api.menu_click("edit.settings")
            ctx.expect(
                bool(_poll(ctx, lambda: _settings_visible(ctx))),
                "Settings-Region wurde nicht sichtbar",
            )
            ctx.api.click("settings-tab-ki-anbieter")
            ctx.expect(
                bool(
                    _poll(
                        ctx,
                        lambda: ctx.api.dom("#ai-custom-add").get("exists")
                        and (
                            ctx.api.dom("#ai-provider-list").get("attributes") or {}
                        ).get("data-loading") == "false",
                    )
                ),
                "KI-Anbieter wurden nicht geladen",
            )

        with ctx.step("Custom-Provider ueber den Dialog anlegen"):
            ctx.api.click("ai-custom-add")
            ctx.expect(
                bool(
                    _poll(
                        ctx,
                        lambda: _eval_value(
                            ctx,
                            """(() => {
                                const dialog =
                                    document.getElementById("ai-custom-dialog");
                                return !!dialog && !dialog.hidden;
                            })()""",
                        ),
                    )
                ),
                "Custom-Provider-Dialog wurde nicht sichtbar",
            )
            filled = _eval_value(
                ctx,
                f"""(() => {{
                    document.getElementById("ai-custom-id").value =
                        "{PROVIDER_ID}";
                    document.getElementById("ai-custom-name").value =
                        "E2E Local Provider";
                    document.getElementById("ai-custom-base-url").value =
                        "http://127.0.0.1:1/v1";
                    return true;
                }})()""",
            )
            ctx.expect(filled is True, "Dialogfelder konnten nicht gesetzt werden")
            ctx.api.click("ai-custom-save")
            state = _poll(
                ctx,
                lambda: (
                    current
                    if (current := _custom_state(ctx)).get("exists")
                    else None
                ),
            )
            ctx.expect(bool(state), "Custom-Provider erschien nicht in der Liste")
            ctx.expect(state.get("enabled") is True, f"Provider-State: {state!r}")

        with ctx.step("Aktivierungs-Toggle aus- und wieder einschalten"):
            ctx.api.click(f"ai-provider-enabled-{PROVIDER_ID}")
            state = _poll(
                ctx,
                lambda: (
                    current
                    if (current := _custom_state(ctx)).get("enabled") is False
                    else None
                ),
            )
            ctx.expect(bool(state), "Custom-Provider wurde nicht deaktiviert")
            ctx.api.click(f"ai-provider-enabled-{PROVIDER_ID}")
            state = _poll(
                ctx,
                lambda: (
                    current
                    if (current := _custom_state(ctx)).get("enabled") is True
                    else None
                ),
            )
            ctx.expect(bool(state), "Custom-Provider wurde nicht reaktiviert")

        with ctx.step("Schluessel nur als Passwort setzen und Status pruefen"):
            ctx.api.click(f"ai-auth-edit-{PROVIDER_ID}")
            before = _custom_state(ctx)
            ctx.expect(before.get("keyType") == "password", f"Auth-State: {before!r}")
            assigned = _eval_value(
                ctx,
                f"""(() => {{
                    const input =
                        document.getElementById("ai-auth-key-{PROVIDER_ID}");
                    input.value = {TEST_KEY!r};
                    return input.type === "password";
                }})()""",
            )
            ctx.expect(assigned is True, "Schluesselfeld ist kein Passwortfeld")
            ctx.api.click(f"ai-auth-save-{PROVIDER_ID}")
            state = _poll(
                ctx,
                lambda: (
                    current
                    if (current := _custom_state(ctx)).get("keyStored") is True
                    else None
                ),
            )
            ctx.expect(bool(state), "Auth-Status wechselte nicht auf gespeichert")
            ctx.expect(state.get("keyValue") == "", f"Key nicht geleert: {state!r}")
            ctx.expect(state.get("keyInMarkup") is False, "Key steht im HTML-Markup")
            ctx.expect(state.get("keyInText") is False, "Key steht als DOM-Text")
            ctx.expect(state.get("removeHidden") is False, f"Auth-State: {state!r}")

        with ctx.step("Schluessel ueber die UI wieder entfernen"):
            ctx.api.click(f"ai-auth-remove-{PROVIDER_ID}")
            # Bei Custom-Providern ist der Schluessel optional; strukturell
            # genuegen der fehlende Stored-Marker und der versteckte Remove-Button.
            state = _poll(
                ctx,
                lambda: (
                    current
                    if (current := _custom_state(ctx)).get("keyStored") is False
                    and current.get("removeHidden") is True
                    else None
                ),
            )
            ctx.expect(
                bool(state), "Auth-Status wechselte nicht auf ohne Schluessel"
            )
            ctx.expect(state.get("removeHidden") is True, f"Auth-State: {state!r}")

        with ctx.step("Aktiver Custom-Provider erscheint im Modelle-Tab"):
            ctx.api.click("settings-tab-ki-modelle")
            model_state = _poll(
                ctx,
                lambda: _eval_value(
                    ctx,
                    f"""(() => {{
                        const group = document.querySelector(
                            '[data-ai-model-provider="{PROVIDER_ID}"]'
                        );
                        const fetch = document.getElementById(
                            "ai-models-fetch-{PROVIDER_ID}"
                        );
                        return group && fetch ? {{
                            name: group.textContent,
                            fetchProvider: fetch.dataset.aiModelsFetch,
                            fetchDisabled: fetch.disabled
                        }} : null;
                    }})()""",
                ),
            )
            ctx.expect(bool(model_state), "Custom-Provider-Gruppe fehlt")
            ctx.expect(
                "E2E Local Provider" in model_state.get("name", ""),
                f"Modelle-Ansicht: {model_state!r}",
            )
            ctx.expect(
                model_state.get("fetchProvider") == PROVIDER_ID
                and model_state.get("fetchDisabled") is False,
                f"Modelle-Button: {model_state!r}",
            )

        with ctx.step("Custom-Provider ueber die UI loeschen"):
            ctx.api.click("settings-tab-ki-anbieter")
            ctx.expect(
                bool(_poll(ctx, lambda: _custom_state(ctx).get("exists"))),
                "Custom-Provider fehlt vor dem Loeschen",
            )
            ctx.api.click(f"ai-custom-delete-{PROVIDER_ID}")
            ctx.expect(
                bool(_poll(ctx, lambda: not _custom_state(ctx).get("exists"))),
                "Custom-Provider wurde nicht geloescht",
            )
    finally:
        _cleanup(ctx)
