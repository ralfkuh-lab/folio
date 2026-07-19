//! Tauri-freie Geometrie-Logik fuer den Fenster-Restore beim Boot.
//!
//! Hintergrund: Die persistierte Fenster-Position (`panel-state.json`) kann
//! auf einen inzwischen abgesteckten Monitor zeigen oder — wenn Windows das
//! Fenster beim Minimieren auf die Parkposition -32000/-32000 geschoben und
//! genau das gespeichert wurde — komplett off-screen liegen. Vor dem
//! `set_position` prueft der Boot-Pfad deshalb, ob ein greifbarer Streifen der
//! Titelleiste auf irgendeinem Monitor sichtbar ist; sonst wird auf dem
//! primaeren Monitor zentriert.
//!
//! **Koordinatensystem:** Die Entscheidung faellt vollstaendig in PHYSISCHEN
//! Pixeln — genau in dem System, in dem Tao die Position spaeter tatsaechlich
//! anwendet. Ein pro Monitor durch dessen eigenen Scale geteiltes
//! „logisches" Rechteck ergaebe unter Windows-Mixed-DPI keine gemeinsame
//! Flaeche (Ueberlappungen/Luecken), und `set_position(LogicalPosition)`
//! rechnet ohnehin mit dem aktuellen Scale des FENSTERS in physisch um, nicht
//! mit dem des Zielmonitors. Der Aufrufer (`lib.rs`) rechnet die gespeicherten
//! logischen Werte einmal mit `window.scale_factor()` in physisch um
//! (`to_physical`) und reicht sie hier fertig herein; die Monitor-Rechtecke
//! (Work-Areas) bleiben unveraendert physisch.
//!
//! Bewusst reine Funktionen ohne Tauri-Abhaengigkeit — so ist die Logik
//! inklusive Scale-Umrechnung und Mixed-DPI-Topologien unit-testbar.

/// Basis-Mindestbreite des greifbaren Titelleisten-Streifens in LOGISCHEN
/// Pixeln. Der Aufrufer multipliziert mit dem Fenster-Scale, um den
/// physischen Schwellwert zu erhalten.
pub const MIN_VISIBLE_WIDTH_LOGICAL: f64 = 100.0;
/// Basis-Mindesthoehe des greifbaren Streifens in LOGISCHEN Pixeln.
pub const MIN_VISIBLE_HEIGHT_LOGICAL: f64 = 50.0;

/// Rechteck (Position + Groesse). Interpretation ist durchgaengig PHYSISCH.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Ergebnis der Sichtbarkeitspruefung fuer die gespeicherte Fenster-Position.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PositionDecision {
    /// Gespeicherte Position ist ausreichend sichtbar — unveraendert (als
    /// LogicalPosition mit den Originalwerten) anwenden.
    Keep,
    /// Off-screen — auf diese PHYSISCHE Position zentrieren (als
    /// PhysicalPosition anwenden).
    Recenter { x: f64, y: f64 },
    /// Off-screen/unvalidierbar und kein primaerer Monitor bekannt — Position
    /// gar nicht setzen (OS-Default greift).
    Leave,
}

/// Wandelt einen logischen Wert mit dem Fenster-Scale in physische Pixel um —
/// genau wie Tao es bei `set_position`/`set_size(Logical…)` tut.
pub fn to_physical(logical: f64, scale: f64) -> f64 {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    logical * scale
}

/// Liefert die tatsaechlich beim Boot verwendete (logische) Fenstergroesse:
/// die gespeicherte nur, wenn BEIDE Dimensionen finit und positiv sind (dann
/// wird sie auch per `set_size` angewendet); sonst den App-Default. Damit
/// beschreibt das fuer den Sichtbarkeitstest angenommene Fenster genau das,
/// das spaeter positioniert wird.
pub fn effective_size(
    stored_width: Option<f64>,
    stored_height: Option<f64>,
    default_width: f64,
    default_height: f64,
) -> (f64, f64) {
    if stored_size_valid(stored_width, stored_height) {
        (stored_width.unwrap(), stored_height.unwrap())
    } else {
        (default_width, default_height)
    }
}

/// Sind beide gespeicherten Dimensionen vorhanden, finit und positiv? Nur dann
/// darf `set_size` sie anwenden (und der Sichtbarkeitstest sie annehmen).
pub fn stored_size_valid(stored_width: Option<f64>, stored_height: Option<f64>) -> bool {
    matches!(
        (stored_width, stored_height),
        (Some(w), Some(h)) if is_positive_finite(w) && is_positive_finite(h)
    )
}

fn is_positive_finite(v: f64) -> bool {
    v.is_finite() && v > 0.0
}

/// Ein Rechteck ist nur gueltig, wenn alle Werte finit und Breite/Hoehe positiv
/// sind. Ungueltige Fenster-/Monitor-Rechtecke gelten als nicht sichtbar
/// (verhindert u. a. dass `height <= 0` den vertikalen Test trivial erfuellt).
fn rect_is_valid(r: &Rect) -> bool {
    r.x.is_finite()
        && r.y.is_finite()
        && r.width.is_finite()
        && r.height.is_finite()
        && r.width > 0.0
        && r.height > 0.0
}

/// Breite/Hoehe der Schnittmenge zweier Rechtecke (0 bei keiner Ueberlappung).
fn intersect_dims(a: &Rect, b: &Rect) -> (f64, f64) {
    let left = a.x.max(b.x);
    let right = (a.x + a.width).min(b.x + b.width);
    let top = a.y.max(b.y);
    let bottom = (a.y + a.height).min(b.y + b.height);
    ((right - left).max(0.0), (bottom - top).max(0.0))
}

/// Liegt ein greifbarer Streifen (>= `min_visible_w` x `min_visible_h`
/// physische Pixel) des oberen Fensterbereichs auf mindestens einem Monitor?
/// `monitors` sind die physischen Work-Areas (nicht die vollen Monitorflaechen)
/// — so faellt ein Streifen hinter einer Taskleiste/Menuebalken korrekt als
/// nicht greifbar durch.
pub fn is_sufficiently_visible(
    window: &Rect,
    monitors: &[Rect],
    min_visible_w: f64,
    min_visible_h: f64,
) -> bool {
    if !rect_is_valid(window) {
        return false;
    }
    // Nur der obere Fensterstreifen zaehlt — der Nutzer muss die Titelleiste
    // greifen koennen. Ein Fenster, das nur mit seinem unteren Rand einen
    // Monitor beruehrt (Titelleiste oberhalb des Schirms), gilt als weg.
    let strip_height = min_visible_h.min(window.height);
    let strip = Rect {
        x: window.x,
        y: window.y,
        width: window.width,
        height: strip_height,
    };
    monitors.iter().filter(|m| rect_is_valid(m)).any(|m| {
        let (w, h) = intersect_dims(&strip, m);
        w >= min_visible_w && h >= strip_height
    })
}

/// Entscheidet, wie mit der gespeicherten Fenster-Position umzugehen ist.
///
/// - sichtbar -> `Keep`
/// - off-screen ODER nicht validierbar (leere Monitorliste) + primaerer
///   Monitor bekannt -> `Recenter` (physisch auf dessen Work-Area zentriert)
/// - andernfalls -> `Leave`
///
/// Eine leere Monitorliste liefert NIE `Keep`: ohne Validierungsgrundlage
/// wuerde sonst eine bereits korrupte Parkposition erneut blind angewendet.
pub fn decide_position(
    window: &Rect,
    monitors: &[Rect],
    primary: Option<&Rect>,
    min_visible_w: f64,
    min_visible_h: f64,
) -> PositionDecision {
    if !monitors.is_empty()
        && is_sufficiently_visible(window, monitors, min_visible_w, min_visible_h)
    {
        return PositionDecision::Keep;
    }
    match primary {
        Some(p) if rect_is_valid(p) => {
            // Auf der Work-Area des primaeren Monitors zentrieren; bei einem
            // Fenster, das groesser als die Work-Area ist, nicht ueber deren
            // obere/linke Kante hinaus (sonst waere die Titelleiste wieder weg
            // bzw. unter der Taskleiste).
            let x = (p.x + (p.width - window.width) / 2.0).max(p.x);
            let y = (p.y + (p.height - window.height) / 2.0).max(p.y);
            PositionDecision::Recenter { x, y }
        }
        _ => PositionDecision::Leave,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    // 100/50 logische Basis bei Scale 1.0 == physisch fuer die 1.0-Tests.
    const MW1: f64 = MIN_VISIBLE_WIDTH_LOGICAL;
    const MH1: f64 = MIN_VISIBLE_HEIGHT_LOGICAL;

    #[test]
    fn to_physical_multiplies_by_window_scale() {
        assert_eq!(to_physical(3900.0, 2.0), 7800.0);
        assert_eq!(to_physical(100.0, 1.0), 100.0);
        // Ungueltiger Scale faellt auf 1.0 zurueck.
        assert_eq!(to_physical(200.0, 0.0), 200.0);
        assert_eq!(to_physical(200.0, f64::NAN), 200.0);
    }

    #[test]
    fn effective_size_uses_stored_only_when_both_valid() {
        assert_eq!(
            effective_size(Some(1600.0), Some(900.0), 1200.0, 800.0),
            (1600.0, 900.0)
        );
        // Nur eine Dimension vorhanden -> App-Default fuer beide Achsen.
        assert_eq!(
            effective_size(Some(2000.0), None, 1200.0, 800.0),
            (1200.0, 800.0)
        );
        assert_eq!(
            effective_size(None, Some(900.0), 1200.0, 800.0),
            (1200.0, 800.0)
        );
        // 0 / negativ / nicht-finit -> App-Default.
        assert_eq!(
            effective_size(Some(0.0), Some(900.0), 1200.0, 800.0),
            (1200.0, 800.0)
        );
        assert_eq!(
            effective_size(Some(1600.0), Some(-10.0), 1200.0, 800.0),
            (1200.0, 800.0)
        );
        assert_eq!(
            effective_size(Some(f64::INFINITY), Some(900.0), 1200.0, 800.0),
            (1200.0, 800.0)
        );
        assert_eq!(effective_size(None, None, 1200.0, 800.0), (1200.0, 800.0));
    }

    #[test]
    fn stored_size_valid_predicate() {
        assert!(stored_size_valid(Some(10.0), Some(20.0)));
        assert!(!stored_size_valid(Some(10.0), None));
        assert!(!stored_size_valid(Some(0.0), Some(20.0)));
        assert!(!stored_size_valid(Some(10.0), Some(f64::NAN)));
    }

    #[test]
    fn fully_visible_window_is_kept() {
        let monitors = [rect(0.0, 0.0, 1920.0, 1080.0)];
        let window = rect(200.0, 150.0, 1024.0, 768.0);
        assert!(is_sufficiently_visible(&window, &monitors, MW1, MH1));
        assert_eq!(
            decide_position(&window, &monitors, Some(&monitors[0]), MW1, MH1),
            PositionDecision::Keep
        );
    }

    #[test]
    fn off_screen_second_monitor_recenters_on_primary() {
        // Nur der primaere Monitor ist noch da; das Fenster wurde auf dem
        // inzwischen abgesteckten Zweitmonitor gespeichert.
        let primary = rect(0.0, 0.0, 1920.0, 1080.0);
        let monitors = [primary];
        let window = rect(2500.0, 300.0, 1024.0, 768.0);
        assert!(!is_sufficiently_visible(&window, &monitors, MW1, MH1));
        assert_eq!(
            decide_position(&window, &monitors, Some(&primary), MW1, MH1),
            PositionDecision::Recenter {
                x: (1920.0 - 1024.0) / 2.0,
                y: (1080.0 - 768.0) / 2.0,
            }
        );
    }

    #[test]
    fn windows_park_position_recenters() {
        let primary = rect(0.0, 0.0, 1920.0, 1080.0);
        let monitors = [primary];
        let window = rect(-32000.0, -32000.0, 1024.0, 768.0);
        assert!(!is_sufficiently_visible(&window, &monitors, MW1, MH1));
        assert_eq!(
            decide_position(&window, &monitors, Some(&primary), MW1, MH1),
            PositionDecision::Recenter {
                x: (1920.0 - 1024.0) / 2.0,
                y: (1080.0 - 768.0) / 2.0,
            }
        );
    }

    #[test]
    fn borderline_just_visible_is_kept() {
        let monitors = [rect(0.0, 0.0, 1920.0, 1080.0)];
        // Genau 100 px Breite und die vollen 50 px Hoehe des Streifens liegen
        // noch auf dem Monitor.
        let window = rect(-924.0, 0.0, 1024.0, 768.0);
        assert!(is_sufficiently_visible(&window, &monitors, MW1, MH1));
        assert_eq!(
            decide_position(&window, &monitors, Some(&monitors[0]), MW1, MH1),
            PositionDecision::Keep
        );
    }

    #[test]
    fn borderline_just_under_recenters() {
        let primary = rect(0.0, 0.0, 1920.0, 1080.0);
        let monitors = [primary];
        // Ein Pixel weiter links: nur noch 99 px sichtbar -> zu wenig.
        let window = rect(-925.0, 0.0, 1024.0, 768.0);
        assert!(!is_sufficiently_visible(&window, &monitors, MW1, MH1));
        assert!(matches!(
            decide_position(&window, &monitors, Some(&primary), MW1, MH1),
            PositionDecision::Recenter { .. }
        ));
    }

    #[test]
    fn title_bar_above_monitor_top_is_not_visible() {
        // Fenster ragt nur mit dem unteren Rand in den Monitor; die
        // Titelleiste liegt oberhalb des Schirms -> nicht greifbar.
        let monitors = [rect(0.0, 0.0, 1920.0, 1080.0)];
        let window = rect(200.0, -740.0, 1024.0, 768.0);
        assert!(!is_sufficiently_visible(&window, &monitors, MW1, MH1));
    }

    #[test]
    fn mixed_dpi_regression_recenters_after_physical_conversion() {
        // Regressionsfall aus dem Review: primaerer Monitor 3840 px @ 2.0 bei
        // x=0, Zweitmonitor 1920 px @ 1.0 physisch bei x=3840. Gespeicherte
        // logische x=3900 bei Fenster-Scale 2.0 -> physisch 7800 -> off-screen.
        // (Der alte pro-Monitor-„logische" Ansatz haette hier faelschlich
        // Keep geliefert.)
        let scale = 2.0;
        let primary = rect(0.0, 0.0, 3840.0, 2160.0);
        let secondary = rect(3840.0, 0.0, 1920.0, 1080.0);
        let monitors = [primary, secondary];

        let (lw, lh) = effective_size(Some(1024.0), Some(768.0), 1200.0, 800.0);
        let window = rect(
            to_physical(3900.0, scale),
            to_physical(100.0, scale),
            to_physical(lw, scale),
            to_physical(lh, scale),
        );
        assert_eq!(window.x, 7800.0);
        let min_w = MIN_VISIBLE_WIDTH_LOGICAL * scale;
        let min_h = MIN_VISIBLE_HEIGHT_LOGICAL * scale;
        assert!(!is_sufficiently_visible(&window, &monitors, min_w, min_h));
        assert!(matches!(
            decide_position(&window, &monitors, Some(&primary), min_w, min_h),
            PositionDecision::Recenter { .. }
        ));
    }

    #[test]
    fn mixed_dpi_second_monitor_position_within_physical_bounds_is_kept() {
        // Gegenprobe: eine logische Position, die physisch tatsaechlich auf dem
        // Zweitmonitor landet, bleibt Keep.
        let scale = 2.0;
        let primary = rect(0.0, 0.0, 3840.0, 2160.0);
        let secondary = rect(3840.0, 0.0, 1920.0, 1080.0);
        let monitors = [primary, secondary];
        // logisch x=2000 @ scale 2.0 -> physisch 4000 (liegt in [3840,5760)).
        let window = rect(
            to_physical(2000.0, scale),
            to_physical(50.0, scale),
            to_physical(600.0, scale),
            to_physical(400.0, scale),
        );
        assert_eq!(window.x, 4000.0);
        let min_w = MIN_VISIBLE_WIDTH_LOGICAL * scale;
        let min_h = MIN_VISIBLE_HEIGHT_LOGICAL * scale;
        assert!(is_sufficiently_visible(&window, &monitors, min_w, min_h));
        assert_eq!(
            decide_position(&window, &monitors, Some(&primary), min_w, min_h),
            PositionDecision::Keep
        );
    }

    #[test]
    fn vertically_stacked_monitors_visible_on_lower() {
        // Vertikal angeordnete Monitore: primaer oben, zweiter darunter.
        let primary = rect(0.0, 0.0, 1920.0, 1080.0);
        let lower = rect(0.0, 1080.0, 1920.0, 1080.0);
        let monitors = [primary, lower];
        let window = rect(300.0, 1300.0, 800.0, 600.0);
        assert!(is_sufficiently_visible(&window, &monitors, MW1, MH1));
        assert_eq!(
            decide_position(&window, &monitors, Some(&primary), MW1, MH1),
            PositionDecision::Keep
        );
    }

    #[test]
    fn strip_hidden_behind_top_taskbar_is_not_visible() {
        // Work-Area reserviert oben 50 px (Taskleiste). Ein Fenster, dessen
        // 50-px-Streifen komplett in dieser Leiste liegt, ist nicht greifbar.
        let work_area = rect(0.0, 50.0, 1920.0, 1030.0);
        let monitors = [work_area];
        // Streifen y in [0,40) -> vollstaendig oberhalb der Work-Area.
        let window = rect(300.0, 0.0, 800.0, 40.0);
        assert!(!is_sufficiently_visible(&window, &monitors, MW1, MH1));
        // Direkt an der Work-Area-Oberkante: sichtbar.
        let window_ok = rect(300.0, 50.0, 800.0, 600.0);
        assert!(is_sufficiently_visible(&window_ok, &monitors, MW1, MH1));
    }

    #[test]
    fn recenter_respects_work_area_origin() {
        // Recenter darf die Titelleiste nicht in eine oben reservierte Leiste
        // schieben: ein uebergrosses Fenster wird auf den Work-Area-Ursprung
        // geklemmt (hier y=50 statt y=0).
        let work_area = rect(0.0, 50.0, 1920.0, 1030.0);
        let monitors = [work_area];
        let window = rect(-32000.0, -32000.0, 2200.0, 1200.0);
        assert_eq!(
            decide_position(&window, &monitors, Some(&work_area), MW1, MH1),
            PositionDecision::Recenter { x: 0.0, y: 50.0 }
        );
    }

    #[test]
    fn empty_monitors_with_primary_recenters_park_position() {
        // Monitorliste leer (API-Fehler o. Ä.), aber Primary bekannt: eine
        // Parkposition darf NICHT blind uebernommen werden -> Recenter.
        let primary = rect(0.0, 0.0, 1920.0, 1080.0);
        let window = rect(-32000.0, -32000.0, 1024.0, 768.0);
        assert_eq!(
            decide_position(&window, &[], Some(&primary), MW1, MH1),
            PositionDecision::Recenter {
                x: (1920.0 - 1024.0) / 2.0,
                y: (1080.0 - 768.0) / 2.0,
            }
        );
    }

    #[test]
    fn empty_monitors_without_primary_leaves_os_default() {
        let window = rect(-32000.0, -32000.0, 1024.0, 768.0);
        assert_eq!(
            decide_position(&window, &[], None, MW1, MH1),
            PositionDecision::Leave
        );
    }

    #[test]
    fn off_screen_without_primary_leaves_os_default() {
        let monitors = [rect(0.0, 0.0, 1920.0, 1080.0)];
        let window = rect(-32000.0, -32000.0, 1024.0, 768.0);
        assert_eq!(
            decide_position(&window, &monitors, None, MW1, MH1),
            PositionDecision::Leave
        );
    }

    #[test]
    fn invalid_window_rect_is_not_visible() {
        let monitors = [rect(0.0, 0.0, 1920.0, 1080.0)];
        // height <= 0 darf nicht ueber strip_height=0 den Test trivial
        // erfuellen.
        assert!(!is_sufficiently_visible(
            &rect(100.0, 100.0, 800.0, 0.0),
            &monitors,
            MW1,
            MH1
        ));
        assert!(!is_sufficiently_visible(
            &rect(100.0, 100.0, 800.0, -600.0),
            &monitors,
            MW1,
            MH1
        ));
        assert!(!is_sufficiently_visible(
            &rect(f64::NAN, 100.0, 800.0, 600.0),
            &monitors,
            MW1,
            MH1
        ));
    }

    #[test]
    fn invalid_monitor_rect_is_ignored() {
        // Ein ungueltiges Monitorrechteck darf keine Sichtbarkeit vortaeuschen.
        let monitors = [rect(0.0, 0.0, 0.0, 0.0)];
        let window = rect(10.0, 10.0, 800.0, 600.0);
        assert!(!is_sufficiently_visible(&window, &monitors, MW1, MH1));
    }

    #[test]
    fn oversized_window_is_clamped_to_work_area_origin() {
        let primary = rect(100.0, 100.0, 800.0, 600.0);
        let monitors = [primary];
        let window = rect(5000.0, 5000.0, 1200.0, 900.0);
        assert_eq!(
            decide_position(&window, &monitors, Some(&primary), MW1, MH1),
            PositionDecision::Recenter { x: 100.0, y: 100.0 }
        );
    }
}
