use folio::navigation::NavigationController;

#[test]
fn full_navigation_lifecycle_walks_back_and_forward() {
    let mut nav = NavigationController::new();

    nav.navigate("/a", None);
    nav.navigate("/b", None);
    nav.navigate("/c", None);

    assert_eq!("/c", nav.current().unwrap().absolute_path);
    assert_eq!("/b", nav.go_back().unwrap().absolute_path);
    assert_eq!("/b", nav.current().unwrap().absolute_path);
    assert_eq!("/a", nav.go_back().unwrap().absolute_path);
    assert_eq!("/a", nav.current().unwrap().absolute_path);

    assert_eq!("/b", nav.go_forward().unwrap().absolute_path);
    assert_eq!("/b", nav.current().unwrap().absolute_path);
    assert_eq!("/c", nav.go_forward().unwrap().absolute_path);
    assert_eq!("/c", nav.current().unwrap().absolute_path);
}

#[test]
fn scroll_position_is_persisted_per_history_entry() {
    let mut nav = NavigationController::new();

    nav.navigate("/a", None);
    nav.update_scroll_position(10.0);
    nav.navigate("/b", None);
    nav.update_scroll_position(20.5);
    nav.go_back();
    nav.update_scroll_position(12.25);

    assert_eq!(12.25, nav.current().unwrap().scroll_y);
    assert_eq!(20.5, nav.go_forward().unwrap().scroll_y);
}

#[test]
fn navigate_stores_anchor_with_entry() {
    let mut nav = NavigationController::new();

    nav.navigate("/guide.md", Some("install".into()));

    let current = nav.current().unwrap();
    assert_eq!("/guide.md", current.absolute_path);
    assert_eq!(Some("install"), current.anchor.as_deref());
}

#[test]
fn navigating_after_back_discards_forward_history() {
    let mut nav = NavigationController::new();

    nav.navigate("/a", None);
    nav.navigate("/b", None);
    nav.navigate("/c", None);
    nav.go_back();
    nav.navigate("/d", Some("fresh".into()));

    assert!(!nav.can_go_forward());
    assert_eq!(3, nav.history().len());
    assert_eq!("/d", nav.current().unwrap().absolute_path);
}
