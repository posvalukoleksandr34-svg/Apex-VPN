//! Installed applications, for the split tunnelling picker. Runs in the
//! user's session (desktop app), not in the service.

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct InstalledApp {
    pub name: String,
    /// Absolute path to the main executable.
    pub path: String,
}

#[cfg(windows)]
pub fn installed() -> Vec<InstalledApp> {
    crate::windows::apps::installed()
}

#[cfg(not(windows))]
pub fn installed() -> Vec<InstalledApp> {
    // Integration point: parse *.desktop files (Linux) / /Applications (macOS).
    Vec::new()
}
