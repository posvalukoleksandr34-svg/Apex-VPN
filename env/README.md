# Settings

Every setting the product reads, per environment. **Only templates, scripts and docs are in git.** The real files with secrets are made on the machine that uses them, and `.gitignore` keeps them out.

```
env/
├─ generate.sh               makes a deployment's real files from the templates, with fresh secrets
├─ check.sh                  checks them before going live (and runs the API's own check)
├─ production/
│  ├─ stack.env.example      domains, Cloudflare tunnel token, which images run
│  ├─ api.env.example        the account API: database, keys, email, Stripe, staff tools
│  ├─ web.env.example        the web dashboard
│  ├─ desktop-build.env.example   building the Windows installer (API address, server-list key, signing)
│  ├─ node.env.example       a VPN node's agent (written by deploy/node/setup.sh)
│  ├─ stack.env, api.env, web.env, desktop-build.env    ← made by generate.sh (gitignored, 0600)
│  ├─ secrets/supabase-ca.crt                           ← the database's CA certificate (gitignored)
│  └─ certs/origin.pem, origin.key                      ← option B only (gitignored)
├─ staging/                  the same, made from the production templates with Stripe test mode
└─ development/              what `npm run dev:keys -w server/api` writes to the .env.local files
```

## Production, on the server

```bash
bash env/generate.sh production --domain example.com
```

It writes the four files with your domain, three API keys, the dashboard's session secret, and the server-list key for the desktop app. Then:

1. **Fill in what only you have:**
   * `stack.env`: `TUNNEL_TOKEN`.
   * `api.env`:
     * `DATABASE_URL`: replace `<project-ref>` and `<database-password>`, and check the region in the host name.
     * `SMTP_URL`: the SMTP login, password and host.
     * The Stripe values.
2. **Add the certificate:** put Supabase's CA certificate at `env/production/secrets/supabase-ca.crt`.
3. **Check:** `bash env/check.sh production`. Fix what it lists until it says **Ready**.
4. **Start:** `bash deploy/app/stack.sh production up -d --build` (docs/PRODUCTION.md has the whole path).

Keep `api.env` and `web.env` in a password manager too:
* losing `DATA_ENCRYPTION_KEY` makes stored two-step secrets unreadable;
* changing `RELAY_SIGNING_SEED` needs a new desktop release.

`generate.sh` never overwrites a file. To start one again, delete it; for the keys, see what changing each one does in `api.env.example`.

## The Windows installer

`desktop-build.env` holds no secret: it has the API's address and the server list's **public** key. Copy it to the build machine, add the code-signing certificate (`APEXY_SIGN_THUMBPRINT` or `APEXY_SIGN_PFX`), then:

```powershell
. .\scripts\load-env.ps1 env\production\desktop-build.env
npm run release -w apps/desktop
```

## Every variable

The templates list them all, with defaults, as commented `# NAME=value` lines. Tests keep this true:
* `server/api/test/env.test.ts` fails if the API reads a variable the templates don't mention, or a template names one it doesn't read. It also checks that the production template, once filled, passes the API's production rules.
* `apps/web/src/lib/env.test.ts` does the same for the dashboard.
