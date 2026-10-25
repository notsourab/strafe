#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication, NSWorkspace};
#[cfg(target_os = "macos")]
use std::sync::Mutex;
use tauri::WebviewWindow;

#[derive(Default)]
struct FocusHandoff<App> {
    previous_app: Option<App>,
}

impl<App: PartialEq> FocusHandoff<App> {
    fn remember(&mut self, frontmost: Option<App>, strafe: &App) {
        self.previous_app = frontmost.filter(|app| app != strafe);
    }

    fn dismiss<Error>(
        &mut self,
        strafe_has_focus: bool,
        hide: impl FnOnce() -> Result<(), Error>,
    ) -> Result<Option<App>, Error> {
        hide()?;
        let previous = self.previous_app.take();
        Ok(if strafe_has_focus { previous } else { None })
    }
}

#[derive(Default)]
pub struct FocusTracker {
    #[cfg(target_os = "macos")]
    handoff: Mutex<FocusHandoff<Retained<NSRunningApplication>>>,
}

impl FocusTracker {
    pub fn remember_frontmost_app(&self) {
        #[cfg(target_os = "macos")]
        self.handoff.lock().unwrap().remember(
            NSWorkspace::sharedWorkspace().frontmostApplication(),
            &NSRunningApplication::currentApplication(),
        );
    }

    pub fn dismiss(&self, window: &WebviewWindow) -> tauri::Result<()> {
        #[cfg(target_os = "macos")]
        {
            let strafe_has_focus = window.is_focused()?;
            let previous = self
                .handoff
                .lock()
                .unwrap()
                .dismiss(strafe_has_focus, || window.hide())?;
            if let Some(app) = previous {
                let _ = app.activateWithOptions(NSApplicationActivationOptions::empty());
            }
        }

        #[cfg(not(target_os = "macos"))]
        window.hide()?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::FocusHandoff;

    #[test]
    fn returns_focus_to_the_app_that_was_active_before_strafe() {
        let mut handoff = FocusHandoff::default();
        handoff.remember(Some("browser"), &"strafe");

        let target = handoff.dismiss(true, || Ok::<_, ()>(())).unwrap();

        assert_eq!(target, Some("browser"));
    }

    #[test]
    fn leaves_focus_alone_if_the_user_switched_away() {
        let mut handoff = FocusHandoff::default();
        handoff.remember(Some("browser"), &"strafe");

        let target = handoff.dismiss(false, || Ok::<_, ()>(())).unwrap();

        assert_eq!(target, None);
    }

    #[test]
    fn retains_the_previous_app_when_hiding_fails() {
        let mut handoff = FocusHandoff::default();
        handoff.remember(Some("browser"), &"strafe");

        assert_eq!(
            handoff.dismiss(true, || Err("hide failed")),
            Err("hide failed")
        );
        assert_eq!(
            handoff.dismiss(true, || Ok::<_, ()>(())),
            Ok(Some("browser"))
        );
    }

    #[test]
    fn does_not_record_strafe_as_its_own_previous_app() {
        let mut handoff = FocusHandoff::default();
        handoff.remember(Some("strafe"), &"strafe");

        let target = handoff.dismiss(true, || Ok::<_, ()>(())).unwrap();

        assert_eq!(target, None);
    }
}
