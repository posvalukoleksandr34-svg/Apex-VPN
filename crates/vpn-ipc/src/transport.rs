//! OS transports.
//!
//! **Windows:** named pipe `\\.\pipe\apexy` with an explicit DACL: full
//! access for SYSTEM and Administrators, read/write for interactively
//! signed-in users, nothing for network logons or services. Remote clients
//! are rejected, and the first instance is created with
//! `FILE_FLAG_FIRST_PIPE_INSTANCE`, so a process that squatted the name
//! first makes the service fail loudly instead of talking to an impostor.
//!
//! **Unix:** a socket in a root-owned directory, mode 0660, group `apexy`.

use std::io;

use tokio::io::{AsyncRead, AsyncWrite};

pub trait Stream: AsyncRead + AsyncWrite + Unpin + Send + 'static {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + 'static> Stream for T {}

#[cfg(windows)]
pub use self::windows::*;

#[cfg(unix)]
pub use self::unix::*;

#[cfg(windows)]
mod windows {
    use super::*;
    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeServer, ServerOptions};
    use windows_sys::Win32::Foundation::{LocalFree, ERROR_PIPE_BUSY};
    use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
    use windows_sys::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId;

    /// SYSTEM + Administrators: full; interactive users: read/write.
    const PIPE_SDDL: &str = "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;IU)";

    pub struct Listener {
        path: String,
        next: Option<NamedPipeServer>,
    }

    impl Listener {
        pub fn bind(path: &str) -> io::Result<Self> {
            let first = create(path, true)?;
            Ok(Self { path: path.to_string(), next: Some(first) })
        }

        /// Waits for a client and returns its stream plus the client PID.
        pub async fn accept(&mut self) -> io::Result<(Box<dyn Stream>, Option<u32>)> {
            let server = match self.next.take() {
                Some(s) => s,
                None => create(&self.path, false)?,
            };
            server.connect().await?;
            // Queue the next instance before handing this one out.
            self.next = Some(create(&self.path, false)?);
            let pid = client_pid(&server);
            Ok((Box::new(server), pid))
        }
    }

    fn create(path: &str, first: bool) -> io::Result<NamedPipeServer> {
        let sddl: Vec<u16> = PIPE_SDDL.encode_utf16().chain(Some(0)).collect();
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1, &mut sd, std::ptr::null_mut())
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut attrs = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd,
            bInheritHandle: 0,
        };
        let result = unsafe {
            ServerOptions::new()
                .first_pipe_instance(first)
                .reject_remote_clients(true)
                .max_instances(32)
                .create_with_security_attributes_raw(path, (&mut attrs as *mut SECURITY_ATTRIBUTES).cast())
        };
        unsafe { LocalFree(sd.cast()) };
        result
    }

    fn client_pid(server: &NamedPipeServer) -> Option<u32> {
        use std::os::windows::io::AsRawHandle;
        let mut pid = 0u32;
        (unsafe { GetNamedPipeClientProcessId(server.as_raw_handle() as _, &mut pid) } != 0).then_some(pid)
    }

    pub async fn connect(path: &str) -> io::Result<Box<dyn Stream>> {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            match ClientOptions::new().open(path) {
                Ok(c) => return Ok(Box::new(c)),
                Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) && tokio::time::Instant::now() < deadline => {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
                Err(e) => return Err(e),
            }
        }
    }
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::{UnixListener, UnixStream};

    pub struct Listener(UnixListener);

    impl Listener {
        pub fn bind(path: &str) -> io::Result<Self> {
            let p = std::path::Path::new(path);
            if let Some(dir) = p.parent() {
                std::fs::create_dir_all(dir)?;
                std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o755))?;
            }
            let _ = std::fs::remove_file(p);
            let listener = UnixListener::bind(p)?;
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o660))?;
            Ok(Self(listener))
        }

        pub async fn accept(&mut self) -> io::Result<(Box<dyn Stream>, Option<u32>)> {
            let (stream, _) = self.0.accept().await?;
            let pid = stream.peer_cred().ok().and_then(|c| c.pid()).map(|p| p as u32);
            Ok((Box::new(stream), pid))
        }
    }

    pub async fn connect(path: &str) -> io::Result<Box<dyn Stream>> {
        Ok(Box::new(UnixStream::connect(path).await?))
    }
}
