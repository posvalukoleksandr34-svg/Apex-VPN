//! Service diagnostics log (`logs/service.log`, daily rotation, 7 files),
//! separate from the user-facing connection log. Every line passes through
//! the same redaction as the connection log.

use std::io::Write;
use std::path::Path;

use tracing_appender::rolling::{Builder, Rotation};
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;

pub struct Guard(#[allow(dead_code)] tracing_appender::non_blocking::WorkerGuard);

pub fn init(log_dir: &Path, foreground: bool) -> anyhow::Result<Guard> {
    let appender = Builder::new()
        .rotation(Rotation::DAILY)
        .filename_prefix("service")
        .filename_suffix("log")
        .max_log_files(7)
        .build(log_dir)?;
    let (writer, guard) = tracing_appender::non_blocking(appender);
    let filter = EnvFilter::try_from_env("MERIDIAN_LOG").unwrap_or_else(|_| EnvFilter::new("info,wireguard_nt=info"));
    let file_layer = tracing_subscriber::fmt::layer().with_ansi(false).with_writer(Redacting(writer));
    let console = foreground.then(|| tracing_subscriber::fmt::layer().with_writer(Redacting(std::io::stderr)));
    tracing_subscriber::registry().with(filter).with(file_layer).with(console).init();
    Ok(Guard(guard))
}

/// Wraps a writer so that each formatted event is redacted before it's
/// written. (Diagnostic mode only affects the connection log; the service
/// log is always masked.)
struct Redacting<M>(M);

impl<'a, M: MakeWriter<'a>> MakeWriter<'a> for Redacting<M> {
    type Writer = RedactingWriter<M::Writer>;

    fn make_writer(&'a self) -> Self::Writer {
        RedactingWriter(self.0.make_writer())
    }
}

struct RedactingWriter<W>(W);

impl<W: Write> Write for RedactingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let text = String::from_utf8_lossy(buf);
        self.0.write_all(vpn_core::redact::redact(&text).as_bytes())?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.0.flush()
    }
}
