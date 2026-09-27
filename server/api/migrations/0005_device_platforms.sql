-- Devices set up from the web dashboard with a WireGuard config or QR code:
-- phones and routers, next to the desktop platforms.
ALTER TABLE ops.devices DROP CONSTRAINT devices_platform_check;
ALTER TABLE ops.devices ADD CONSTRAINT devices_platform_check
  CHECK (platform IN ('windows', 'macos', 'linux', 'ios', 'android', 'router', 'other'));
