mod commands;
mod config;
mod fetcher;
mod focus;
mod search;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[tauri::command]
fn dismiss_window(
    window: tauri::WebviewWindow,
    tracker: tauri::State<'_, focus::FocusTracker>,
) -> Result<(), String> {
    tracker.dismiss(&window).map_err(|error| error.to_string())
}

fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let settings_item = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&settings_item, &quit_item])?;

    // The menu bar uses a template silhouette; macOS supplies the foreground color.
    let tray_icon = tauri::image::Image::new_owned(
        include_bytes!("../icons/tray-template.rgba").to_vec(),
        32,
        32,
    );
    TrayIconBuilder::new()
        .icon(tray_icon)
        .icon_as_template(true)
        .tooltip("Strafe")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "settings" => {
                if let Some(window) = app.get_webview_window("main") {
                    if !window.is_visible().unwrap_or(false) {
                        app.state::<focus::FocusTracker>().remember_frontmost_app();
                    }
                    let _ = window.emit("show-settings", ());
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}

fn setup_shortcut(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let shortcut = Shortcut::new(Some(Modifiers::ALT), Code::Space);
    let app_handle = app.handle().clone();

    app.handle().plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |_app, _shortcut, event| {
                println!("[strafe] Shortcut event: {:?}", event.state());
                if event.state() == ShortcutState::Pressed {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        if window.is_visible().unwrap_or(false) {
                            let _ = app_handle.state::<focus::FocusTracker>().dismiss(&window);
                        } else {
                            app_handle
                                .state::<focus::FocusTracker>()
                                .remember_frontmost_app();
                            let _ = window.show();
                            let _ = window.set_focus();
                            let _ = window.emit("window-shown", ());
                        }
                    }
                }
            })
            .build(),
    )?;

    match app.global_shortcut().register(shortcut) {
        Ok(_) => println!("[strafe] Global shortcut Alt+Space registered successfully"),
        Err(e) => println!("[strafe] Failed to register global shortcut: {}", e),
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            app.manage(focus::FocusTracker::default());
            setup_tray(app)?;
            setup_shortcut(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::search_query,
            commands::get_ai_summary,
            commands::fetch_single_page,
            commands::get_config,
            commands::save_config,
            dismiss_window,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    // Set the initial policy before the event loop can show a Dock icon.
    #[cfg(target_os = "macos")]
    let app = {
        let mut app = app;
        app.set_activation_policy(tauri::ActivationPolicy::Accessory);
        app
    };

    app.run(|_, _| {});
}
