//! Windows service host: SCM registration, stop/shutdown and power events.

use std::ffi::OsString;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};
use vpn_core::PlatformEvent;
use vpn_types::brand::{SERVICE_DISPLAY_NAME, SERVICE_NAME};
use windows_service::service::{
    PowerEventParam, ServiceAccess, ServiceAction, ServiceActionType, ServiceControl, ServiceControlAccept, ServiceErrorControl,
    ServiceExitCode, ServiceFailureActions, ServiceFailureResetPeriod, ServiceInfo, ServiceStartType, ServiceState, ServiceStatus,
    ServiceType,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};
use windows_service::{define_windows_service, service_dispatcher};

define_windows_service!(ffi_service_main, service_main);

pub fn run() -> anyhow::Result<()> {
    service_dispatcher::start(SERVICE_NAME, ffi_service_main)?;
    Ok(())
}

fn service_main(_args: Vec<OsString>) {
    if let Err(e) = run_service() {
        tracing::error!("service failed: {e:#}");
    }
}

fn run_service() -> anyhow::Result<()> {
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    let (power_tx, power_rx) = mpsc::unbounded_channel::<PlatformEvent>();
    let mut stop_tx = Some(stop_tx);

    let status = service_control_handler::register(SERVICE_NAME, move |control| match control {
        ServiceControl::Stop | ServiceControl::Shutdown | ServiceControl::Preshutdown => {
            if let Some(tx) = stop_tx.take() {
                let _ = tx.send(());
            }
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::PowerEvent(param) => {
            let ev = match param {
                PowerEventParam::Suspend => Some(PlatformEvent::Suspending),
                PowerEventParam::ResumeAutomatic | PowerEventParam::ResumeSuspend => Some(PlatformEvent::Resumed),
                _ => None,
            };
            if let Some(ev) = ev {
                let _ = power_tx.send(ev);
            }
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    })?;

    let set = |state: ServiceState, accept: ServiceControlAccept| {
        let _ = status.set_service_status(ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: state,
            controls_accepted: accept,
            exit_code: ServiceExitCode::Win32(0),
            checkpoint: 0,
            wait_hint: Duration::from_secs(10),
            process_id: None,
        });
    };
    set(ServiceState::StartPending, ServiceControlAccept::empty());

    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    let result = runtime.block_on(async {
        let opts = crate::options(None, None);
        crate::run_daemon(opts, false, async { let _ = stop_rx.await; }, power_rx, || {
            set(
                ServiceState::Running,
                ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN | ServiceControlAccept::POWER_EVENT,
            )
        })
        .await
    });
    set(ServiceState::Stopped, ServiceControlAccept::empty());
    result
}

/// Installs the service, or updates an existing one in place (the
/// installer runs this on every install and upgrade), then starts it.
pub fn install() -> anyhow::Result<()> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE)?;
    let info = ServiceInfo {
        name: SERVICE_NAME.into(),
        display_name: SERVICE_DISPLAY_NAME.into(),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: std::env::current_exe()?,
        launch_arguments: vec!["run-service".into()],
        dependencies: vec![],
        account_name: None, // LocalSystem
        account_password: None,
    };
    let access = ServiceAccess::QUERY_STATUS | ServiceAccess::CHANGE_CONFIG | ServiceAccess::START | ServiceAccess::STOP;
    let service = match manager.open_service(SERVICE_NAME, access) {
        Ok(existing) => {
            // Upgrade: stop the old instance, point the service at this binary.
            stop_and_wait(&existing)?;
            existing.change_config(&info)?;
            existing
        }
        Err(_) => manager.create_service(&info, access)?,
    };
    service.set_description("Keeps the Meridian VPN tunnel, kill switch and DNS protection running.")?;
    // If the service dies, Windows brings it back. While it's down the kill
    // switch's persistent filters keep traffic blocked (no leak), so a fast
    // restart is what gives the user their connection back.
    service.update_failure_actions(ServiceFailureActions {
        reset_period: ServiceFailureResetPeriod::After(Duration::from_secs(24 * 60 * 60)),
        reboot_msg: None,
        command: None,
        actions: Some(vec![
            ServiceAction { action_type: ServiceActionType::Restart, delay: Duration::from_secs(1) },
            ServiceAction { action_type: ServiceActionType::Restart, delay: Duration::from_secs(5) },
            ServiceAction { action_type: ServiceActionType::Restart, delay: Duration::from_secs(30) },
        ]),
    })?;
    // Also restart after a clean exit that reported an error.
    service.set_failure_actions_on_non_crash_failures(true)?;
    service.start::<OsString>(&[])?;
    println!("{SERVICE_NAME} installed and started (restarts automatically if it stops unexpectedly)");
    Ok(())
}

fn stop_and_wait(service: &windows_service::service::Service) -> anyhow::Result<()> {
    if service.query_status()?.current_state == ServiceState::Stopped {
        return Ok(());
    }
    let _ = service.stop();
    for _ in 0..100 {
        if service.query_status()?.current_state == ServiceState::Stopped {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    anyhow::bail!("{SERVICE_NAME} did not stop within 20 seconds")
}

pub fn uninstall() -> anyhow::Result<()> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)?;
    let service =
        manager.open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE)?;
    if service.query_status()?.current_state != ServiceState::Stopped {
        let _ = service.stop();
        for _ in 0..50 {
            if service.query_status()?.current_state == ServiceState::Stopped {
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }
    service.delete()?;
    // Leave nothing behind that could keep blocking the network.
    vpn_platform::windows::reset_firewall().map_err(|e| anyhow::anyhow!("{e}"))?;
    println!("{SERVICE_NAME} removed and firewall rules cleared");
    Ok(())
}
