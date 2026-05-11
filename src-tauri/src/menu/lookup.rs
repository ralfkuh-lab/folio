//! Rekursive Suche im Menü-Baum. `Menu::get(id)` in Tauri 2 ist nur
//! top-level — wir wollen aber in die Datei/Bearbeiten/Ansicht-Submenüs
//! reingehen.

use tauri::menu::{Menu, MenuItemKind, Submenu};
use tauri::Wry;

pub(super) fn find_menu_item(menu: &Menu<Wry>, id: &str) -> Option<tauri::menu::MenuItem<Wry>> {
    fn walk(items: &[MenuItemKind<Wry>], id: &str) -> Option<tauri::menu::MenuItem<Wry>> {
        for item in items {
            match item {
                MenuItemKind::MenuItem(mi) if mi.id().0.as_str() == id => return Some(mi.clone()),
                MenuItemKind::Submenu(sm) => {
                    if let Ok(children) = sm.items() {
                        if let Some(found) = walk(&children, id) {
                            return Some(found);
                        }
                    }
                }
                _ => {}
            }
        }
        None
    }
    walk(&menu.items().ok()?, id)
}

pub(super) fn find_submenu(menu: &Menu<Wry>, id: &str) -> Option<Submenu<Wry>> {
    fn walk(items: &[MenuItemKind<Wry>], id: &str) -> Option<Submenu<Wry>> {
        for item in items {
            if let MenuItemKind::Submenu(sm) = item {
                if sm.id().0.as_str() == id {
                    return Some(sm.clone());
                }
                if let Ok(children) = sm.items() {
                    if let Some(found) = walk(&children, id) {
                        return Some(found);
                    }
                }
            }
        }
        None
    }
    walk(&menu.items().ok()?, id)
}

pub(super) fn find_check_menu_item(
    menu: &Menu<Wry>,
    id: &str,
) -> Option<tauri::menu::CheckMenuItem<Wry>> {
    fn walk(items: &[MenuItemKind<Wry>], id: &str) -> Option<tauri::menu::CheckMenuItem<Wry>> {
        for item in items {
            match item {
                MenuItemKind::Check(ci) if ci.id().0.as_str() == id => return Some(ci.clone()),
                MenuItemKind::Submenu(sm) => {
                    if let Ok(children) = sm.items() {
                        if let Some(found) = walk(&children, id) {
                            return Some(found);
                        }
                    }
                }
                _ => {}
            }
        }
        None
    }
    walk(&menu.items().ok()?, id)
}
