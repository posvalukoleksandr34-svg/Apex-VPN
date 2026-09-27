# Web stack

The account API and the web dashboard on one server, reachable only through a Cloudflare Tunnel. The walkthrough is [docs/PRODUCTION.md](../../docs/PRODUCTION.md).

| File | What it is |
|---|---|
| `Dockerfile.api`, `Dockerfile.web` | The two images. Build from the repository root; they run as `node`, not root. |
| `compose.yaml` | API, dashboard, Caddy and cloudflared. No published ports; read-only containers, all capabilities dropped. |
| `Caddyfile` | Routes `APP_DOMAIN` and `API_DOMAIN`, and turns Cloudflare's client address into the only `X-Forwarded-For` the services see. |
| `compose.direct.yaml`, `Caddyfile.direct` | Option B without a tunnel: port 443 with a Cloudflare Origin CA certificate, and connections from anywhere but Cloudflare dropped. |
| `stack.env.example`, `api.env.example`, `web.env.example` | Settings templates. The real files (`*.env`, `secrets/`, `certs/`) are gitignored. |
| `apexy-stack.service` | systemd: starts the stack at boot; `reload` after updates. |
| `firewall.nft` | Host firewall: SSH only. |
| `ci/smoke.sh` | The CI smoke test of the images (`.github/workflows/images.yml`). |
