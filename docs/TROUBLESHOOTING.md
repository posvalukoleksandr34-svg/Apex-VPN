# Troubleshooting

The app's Diagnostics page runs the same checks the service uses and explains each failure. This page covers what to do from the outside.

## No internet after a crash or while the service is stopped

The kill switch's blocking filters are persistent on purpose: they survive a crashed service so traffic can't leak. If the service isn't coming back, clear them as administrator:

```powershell
target\debug\apexyd.exe reset-firewall      # development
"C:\Program Files\Apexy VPN\apexyd.exe" reset-firewall   # installed
```

This removes every Apexy VPN filter (provider and sublayer included) and changes nothing else.

## "VPN service isn't running"

* Development: start it with `scripts\dev-service.ps1` (it asks for elevation). A plain prompt can't create the tunnel.
* Installed: `sc query ApexyVPN`, then `sc start ApexyVPN` (elevated).
* The app retries on its own every few seconds; the Retry button retries now.

## Handshake timeout ("the server didn't answer")

* **UDP blocked:** try another network. TCP-based protocols are integration points.
* **Key not known to the server:** with the development demo server, idle peers expire. Restarting the app re-registers the device, and so does `apexy login`. Real Apexy VPN nodes sync peers from the API and don't expire them.
* **Server down:** Diagnostics → Server reachability.

## Connected but pages don't load

Run Diagnostics.
* **"DNS: resolvers not answering":** the tunnel resolver doesn't answer. For a node without its own resolver, the relay list must name one (`dnsIpv4`). Workaround: Settings → DNS → Custom.
* **"Routing: bypasses tunnel":** another VPN changed the routes. Close it and reconnect.

## Sign-in says it can't reach Apexy VPN

* The app learns the API address from the service. Before the service has ever run, it uses the address the app was built with (`APEXY_API_URL`).
* Development: is the API running (`npm run api:dev`)?

## The IPv4 leak test says "unable to verify"

The IP check service answered with a local address. The development API runs on this machine, so it can't see your public address. This is expected in development; against the production API the check works.

## Resetting the app's saved session

Windows: Credential Manager → Windows Credentials → remove `Apexy VPN` / `account-session`. Or sign out in the app, which also removes it.
