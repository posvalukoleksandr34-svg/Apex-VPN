; NSIS: installs, upgrades and removes the privileged VPN service alongside
; the app. The installer is per-machine, so it runs elevated (UAC).
;
; meridiand.exe and meridian.exe are staged as sidecars and wireguard.dll as
; a resource (tauri.release.conf.json); all land next to the app. The
; WireGuardNT driver ships inside wireguard.dll and installs itself when the
; service first creates the tunnel adapter; the kill switch uses the Windows
; Filtering Platform, which is part of Windows. Only the service needs
; registering.

!macro NSIS_HOOK_PREINSTALL
  ; Upgrade: a running service keeps meridiand.exe locked. Stop it first
  ; (Stop-Service waits); `meridiand install` below starts the new one.
  DetailPrint "Stopping the Meridian VPN service (if running)"
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -Command "Stop-Service -Name MeridianVPN -ErrorAction SilentlyContinue"'
  Pop $0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Installing the Meridian VPN service"
  nsExec::ExecToLog '"$INSTDIR\meridiand.exe" install'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION "The Meridian VPN service could not be installed (code $0). The app will show the service as unavailable until it is."
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Also removes every firewall filter, so nothing keeps blocking the network.
  DetailPrint "Removing the Meridian VPN service"
  nsExec::ExecToLog '"$INSTDIR\meridiand.exe" uninstall'
  Pop $0
!macroend
