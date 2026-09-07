//! Spawning, readiness and teardown for the bundled `inferno-service`.
//!
//! The app talks to the service over the same public HTTP + WebSocket API as
//! every other client; this module exists only to make sure a service is
//! *there* to talk to. Nothing here proxies a request, and nothing should:
//! a privileged in-process path is a design bug, not a shortcut (SPEC §1).

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use super::error::{ServiceError, ServiceResult};

/// First launch on a cold filesystem is the slow one; 30s is the doc's number.
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const PROBE_INTERVAL: Duration = Duration::from_millis(150);
const PROBE_CONNECT_TIMEOUT: Duration = Duration::from_millis(750);

/// The service's origin and this launch's token, plus the child process when we
/// are the ones who started it.
pub struct ServiceHandle {
    pub base_url: String,
    pub token: String,
    /// How the service was located, for `inferno_service_status` and the logs.
    pub origin: &'static str,
    /// `None` when `INFERNO_SERVICE_URL` pointed us at a service we do not own.
    child: Mutex<Option<Child>>,
}

impl ServiceHandle {
    /// Attach to a service someone else is running. Used by
    /// `INFERNO_SERVICE_URL`, which keeps the frontend loop fast during
    /// development — no rebuild to iterate on the UI.
    fn attached(base_url: String, token: String) -> Self {
        Self {
            base_url,
            token,
            origin: "attached",
            child: Mutex::new(None),
        }
    }

    /// True when this process owns the service and will kill it on exit.
    pub fn managed(&self) -> bool {
        self.child.lock().is_ok_and(|child| child.is_some())
    }

    /// Whether the child is still running. `Ok(None)` means alive.
    pub fn exit_status(&self) -> Option<String> {
        let mut guard = self.child.lock().ok()?;
        let child = guard.as_mut()?;
        match child.try_wait() {
            Ok(Some(status)) => Some(status.to_string()),
            _ => None,
        }
    }

    /// Kill the child. Idempotent, and safe to call from a signal-ish context:
    /// on Windows the job object below is the real guarantee, this is the
    /// tidy path that also runs on other platforms.
    pub fn shutdown(&self) {
        let Ok(mut guard) = self.child.lock() else {
            return;
        };
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for ServiceHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Find or start a service, and do not return until it answers `/health`.
pub fn launch(app: &AppHandle) -> ServiceResult<ServiceHandle> {
    // A service someone started by hand wins over everything. §2.3.
    if let Ok(url) = std::env::var("INFERNO_SERVICE_URL") {
        let url = url.trim_end_matches('/').to_string();
        if !url.is_empty() {
            let token = std::env::var("INFERNO_SERVICE_TOKEN").unwrap_or_default();
            log::info!("attaching to an externally managed service at {url}");
            return Ok(ServiceHandle::attached(url, token));
        }
    }

    let layout = Layout::resolve(app)?;
    let port = free_port()?;
    let token = random_token();
    let config_file = config_file(app)?;
    seed_download_directory(app, &config_file);

    log::info!(
        "starting {} on port {port} (vendor: {})",
        layout.program.display(),
        layout.vendor.display()
    );

    let mut command = Command::new(&layout.program);
    command.args(&layout.args);
    command.arg("--host").arg("127.0.0.1");
    command.arg("--port").arg(port.to_string());

    // Bootstrap values only. Anything else passed here would *pin* that
    // setting: env wins over the config file and `PATCH /api/v1/settings`
    // answers 409 setting_locked, which would quietly kill the app's own
    // settings controls. Everything else comes from the config file.
    command.env("API_TOKEN", &token);
    command.env("INFERNO_CONFIG_FILE", &config_file);
    command.env("FFMPEG_DIR", layout.vendor.join("ffmpeg"));
    command.env("JS_RUNTIME_DIR", layout.vendor.join("js"));
    command.env(
        "CORS_ORIGINS",
        // The Next export is served from a custom scheme; the last entry keeps
        // `npm run dev:web` working in an ordinary browser.
        "http://tauri.localhost,tauri://localhost,http://localhost:3000",
    );

    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    // Always give the child an explicit working directory.
    //
    // The service's download folder defaults to the *relative* `./downloads`,
    // so whatever it inherits decides where videos land. Inheriting the app's
    // own directory put them in `src-tauri/downloads` during development -
    // inside the tree `tauri dev` watches, so every finished download
    // triggered a rebuild and restarted the app mid-job. It looked exactly
    // like a crash on download.
    let working_dir = layout
        .working_dir
        .clone()
        .or_else(|| app.path().app_data_dir().ok())
        .unwrap_or_else(std::env::temp_dir);
    command.current_dir(working_dir);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: without it a console flashes up on every launch.
        command.creation_flags(0x0800_0000);
    }

    let mut child = command.spawn().map_err(|err| ServiceError::Spawn {
        message: format!("{} ({err})", layout.program.display()),
    })?;

    #[cfg(windows)]
    windows_job::confine(&child);

    let base_url = format!("http://127.0.0.1:{port}");

    match wait_until_ready(port, &token, &mut child) {
        Ok(()) => {
            log::info!("service ready at {base_url}");
            Ok(ServiceHandle {
                base_url,
                token,
                origin: layout.origin,
                child: Mutex::new(Some(child)),
            })
        }
        Err(err) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(err)
        }
    }
}

/// Where the service and its vendored binaries live for this build.
struct Layout {
    program: PathBuf,
    args: Vec<String>,
    vendor: PathBuf,
    working_dir: Option<PathBuf>,
    origin: &'static str,
}

impl Layout {
    fn resolve(app: &AppHandle) -> ServiceResult<Self> {
        let mut looked_in: Vec<String> = Vec::new();

        // Packaged: a PyInstaller onedir tree and the vendor directory, both
        // shipped as bundle resources. ffmpeg and ffprobe keep their plain
        // names here — `externalBin` would rename them and yt-dlp derives
        // ffprobe's path from ffmpeg's directory, so a renamed pair breaks
        // every merge (SPEC §8).
        if let Ok(resources) = app.path().resource_dir() {
            let program = resources.join("service").join(executable_name());
            let vendor = resources.join("vendor");
            if program.is_file() {
                return Ok(Self {
                    program,
                    args: Vec::new(),
                    vendor,
                    working_dir: None,
                    origin: "bundled",
                });
            }
            looked_in.push(program.display().to_string());
        }

        // Development: run the checkout's virtualenv directly, so
        // `npm run dev:tauri` needs no build step and no manual service.
        if cfg!(debug_assertions) {
            let checkout = development_checkout();
            let program = checkout.join(".venv").join("Scripts").join("python.exe");
            let program = if program.is_file() {
                program
            } else {
                checkout.join(".venv").join("bin").join("python")
            };
            if program.is_file() {
                return Ok(Self {
                    program,
                    args: vec!["-m".into(), "inferno_service".into()],
                    vendor: checkout.join("vendor"),
                    working_dir: Some(checkout),
                    origin: "development",
                });
            }
            looked_in.push(program.display().to_string());
        }

        Err(ServiceError::Missing {
            path: looked_in.join(", "),
        })
    }
}

fn executable_name() -> &'static str {
    if cfg!(windows) {
        "inferno-service.exe"
    } else {
        "inferno-service"
    }
}

/// `src-tauri/../service` — only ever consulted in debug builds.
fn development_checkout() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("service")
}

/// Settings persist next to the app's other config, not inside the resource
/// directory, which is read-only once installed.
fn config_file(app: &AppHandle) -> ServiceResult<PathBuf> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|err| ServiceError::Io {
            message: format!("no config directory: {err}"),
        })?;
    std::fs::create_dir_all(&directory)?;
    Ok(directory.join("inferno-settings.json"))
}

/// Give a first run a download folder someone can actually find.
///
/// The service defaults to a relative `./downloads`, which is fine for a CLI
/// but not for an installed app - it would put videos beside whatever the
/// process happened to be launched from. The obvious home is the user's own
/// Downloads folder.
///
/// This is written into the *config file*, not passed as `DOWNLOAD_DIR`.
/// Passing it as an environment variable would pin it: env beats the config
/// file and `PATCH /api/v1/settings` then answers `409 setting_locked`, so the
/// app's own "Download folder" control would be dead on arrival (§3.1). As a
/// stored setting it is an ordinary default the user can change.
///
/// Only ever runs when there is no config file at all, so it cannot overwrite
/// a choice someone has already made.
fn seed_download_directory(app: &AppHandle, config_file: &Path) {
    if config_file.exists() {
        return;
    }

    let Ok(downloads) = app.path().download_dir() else {
        return;
    };

    let target = downloads.join("Inferno");
    // `schema_version` and the `values` map are the service's own file format
    // (see `_read_config_file` in config.py); the keys are setting keys.
    let payload = serde_json::json!({
        "schema_version": 1,
        "values": { "downloads.directory": target.to_string_lossy() },
    });

    match serde_json::to_string_pretty(&payload) {
        Ok(contents) => {
            if let Err(err) = std::fs::write(config_file, contents) {
                // Not fatal: the service falls back to its own default.
                log::warn!("could not seed the download folder: {err}");
            } else {
                log::info!("download folder defaults to {}", target.display());
            }
        }
        Err(err) => log::warn!("could not build the seed settings: {err}"),
    }
}

/// Bind port 0, read what the OS gave us, drop the listener. There is a small
/// race between the drop and the child's own bind; in practice it is fine, and
/// the alternative — a fixed port — collides with a second instance every time.
fn free_port() -> ServiceResult<u16> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    Ok(listener.local_addr()?.port())
}

/// A fresh token per launch, so a stale one from a previous run is worthless.
fn random_token() -> String {
    let mut bytes = [0u8; 24];
    if getrandom::fill(&mut bytes).is_err() {
        // getrandom does not fail on any platform we ship to, but a token is
        // not the place to silently carry on with zeroes.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let pid = u128::from(std::process::id());
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = ((nanos ^ (pid << 17)) >> (index % 16 * 8)) as u8;
        }
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The process is up well before the HTTP server is, so poll until `/health`
/// answers. A child that dies in the meantime short-circuits with its stderr,
/// which is where the actual reason lives.
fn wait_until_ready(port: u16, token: &str, child: &mut Child) -> ServiceResult<()> {
    let deadline = Instant::now() + READY_TIMEOUT;

    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(ServiceError::NotReady {
                seconds: READY_TIMEOUT.as_secs(),
                detail: format!("It exited early ({status}). {}", drain_stderr(child)),
            });
        }

        if probe_health(port, token) {
            return Ok(());
        }

        if Instant::now() >= deadline {
            return Err(ServiceError::NotReady {
                seconds: READY_TIMEOUT.as_secs(),
                detail: drain_stderr(child),
            });
        }

        std::thread::sleep(PROBE_INTERVAL);
    }
}

/// One HTTP/1.1 request against loopback, by hand. A dependency-free probe is
/// worth more here than a general HTTP client the app never otherwise needs —
/// every real request the app makes goes out over `fetch` from the frontend.
fn probe_health(port: u16, token: &str) -> bool {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, PROBE_CONNECT_TIMEOUT) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(PROBE_CONNECT_TIMEOUT));
    let _ = stream.set_write_timeout(Some(PROBE_CONNECT_TIMEOUT));

    let request = format!(
        "GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-API-Key: {token}\r\n\
         Accept: application/json\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let mut head = [0u8; 15];
    if stream.read_exact(&mut head).is_err() {
        return false;
    }
    // "HTTP/1.1 200 OK". A 401 here means the token did not match, which is a
    // bug in this module rather than a service that is still starting, so it
    // deliberately does not count as ready.
    head.starts_with(b"HTTP/1.1 200")
}

/// Whatever the child managed to say before giving up. Best effort: the pipe is
/// closed once the process is gone, so a short read is the normal case.
fn drain_stderr(child: &mut Child) -> String {
    let Some(mut stderr) = child.stderr.take() else {
        return String::new();
    };
    let mut buffer = String::new();
    let _ = stderr.read_to_string(&mut buffer);
    let tail: Vec<&str> = buffer.lines().rev().take(8).collect();
    tail.into_iter().rev().collect::<Vec<_>>().join(" / ")
}

/// A Windows child does not die with its parent. Killing it on
/// `RunEvent::Exit` covers the ordinary path, but not a hard kill of the app —
/// and a leaked service holding a port is the classic bug here. A job object
/// with `KILL_ON_JOB_CLOSE` makes the OS do it unconditionally: the last handle
/// closes when this process ends, however it ends.
#[cfg(windows)]
mod windows_job {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use std::sync::OnceLock;

    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// Kept for the life of the process on purpose: the kill fires when the
    /// last handle to the job closes, which is exactly what we want to happen
    /// at exit and never before.
    static JOB: OnceLock<usize> = OnceLock::new();

    pub fn confine(child: &Child) {
        let job = *JOB.get_or_init(|| unsafe {
            match CreateJobObjectW(None, None) {
                Ok(handle) => {
                    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                    let ok = SetInformationJobObject(
                        handle,
                        JobObjectExtendedLimitInformation,
                        std::ptr::addr_of!(limits).cast(),
                        u32::try_from(std::mem::size_of_val(&limits)).unwrap_or(0),
                    );
                    if ok.is_err() {
                        log::warn!("could not configure the service job object: {ok:?}");
                    }
                    handle.0 as usize
                }
                Err(err) => {
                    log::warn!("could not create a job object for the service: {err}");
                    0
                }
            }
        });

        if job == 0 {
            return;
        }

        unsafe {
            let assigned = AssignProcessToJobObject(
                HANDLE(job as *mut std::ffi::c_void),
                HANDLE(child.as_raw_handle()),
            );
            if assigned.is_err() {
                log::warn!("could not confine the service to the job object: {assigned:?}");
            }
        }
    }
}
