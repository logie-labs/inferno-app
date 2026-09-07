//! The entire Rust-side API surface: where the service is, and whether it is
//! still alive.
//!
//! Deliberately two commands. The REST API is **not** proxied through Rust —
//! the frontend calls the service directly over `fetch`, because a proxy layer
//! would drift from the API and reintroduce the privileged path the service is
//! designed not to have.

use serde::Serialize;
use tauri::State;

use super::error::ServiceError;
use super::process::ServiceHandle;

/// What the frontend needs to build every request and socket URL.
#[derive(Debug, Clone, Serialize)]
pub struct Endpoint {
    pub base_url: String,
    pub token: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub base_url: Option<String>,
    /// `bundled`, `development` or `attached`.
    pub origin: Option<&'static str>,
    /// False when `INFERNO_SERVICE_URL` pointed at a service we do not own.
    pub managed: bool,
    /// `None` while the child is alive; the exit status once it is not.
    pub exited: Option<String>,
    /// Why there is no service. Carries the child's stderr when it had some,
    /// because that is where the actual reason lives.
    pub error: Option<String>,
}

/// Either a running service or the reason there is not one.
///
/// The failure is kept rather than discarded so the UI can say what went wrong
/// instead of showing a generic "not running" - a packaging mistake and a port
/// collision need very different responses from whoever sees them.
pub enum ServiceState {
    Running(Box<ServiceHandle>),
    Failed(ServiceError),
}

impl ServiceState {
    pub fn handle(&self) -> Option<&ServiceHandle> {
        match self {
            ServiceState::Running(handle) => Some(handle),
            ServiceState::Failed(_) => None,
        }
    }
}

#[tauri::command]
pub fn inferno_service_endpoint(state: State<ServiceState>) -> Option<Endpoint> {
    state.handle().map(|handle| Endpoint {
        base_url: handle.base_url.clone(),
        token: handle.token.clone(),
    })
}

#[tauri::command]
pub fn inferno_service_status(state: State<ServiceState>) -> Status {
    match state.inner() {
        ServiceState::Running(handle) => Status {
            base_url: Some(handle.base_url.clone()),
            origin: Some(handle.origin),
            managed: handle.managed(),
            exited: handle.exit_status(),
            error: None,
        },
        ServiceState::Failed(error) => Status {
            base_url: None,
            origin: None,
            managed: false,
            exited: None,
            error: Some(error.to_string()),
        },
    }
}
