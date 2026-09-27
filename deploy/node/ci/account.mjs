// Test accounts for deploy/node/ci/e2e.sh, against a development API whose
// mail goes to its log (MAIL_TRANSPORT=console). State (the generated
// password and access token) stays in a 0600 file; nothing secret is printed.
//
//   node account.mjs create <state.json> <api.log>
//   node account.mjs enroll <state.json> <publicKey>   prints the device's tunnel IPv4
//   node account.mjs connected <state.json>            prints how many devices have a live tunnel
//   node account.mjs delete <state.json>
//   node account.mjs node-key <serverId>               prints the node's key from the relay list
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const API = process.env.APEXY_API ?? "http://127.0.0.1:8787";
const [cmd, arg1, arg2] = process.argv.slice(2);

async function call(method, path, body, token) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const load = (file) => JSON.parse(readFileSync(file, "utf8"));

switch (cmd) {
  case "create": {
    const email = `node-e2e-${randomBytes(4).toString("hex")}@example.com`;
    const password = randomBytes(18).toString("base64url");
    await call("POST", "/v1/auth/register", { email, password });
    let code;
    for (let i = 0; i < 20 && !code; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const log = readFileSync(arg2, "utf8");
      const at = log.lastIndexOf(`to=${email}`);
      code = at >= 0 ? log.slice(at).match(/\b\d{6}\b/)?.[0] : undefined;
    }
    if (!code) throw new Error("no verification code in the API log");
    await call("POST", "/v1/auth/verify-email", { email, code });
    const login = await call("POST", "/v1/auth/login", { email, password, device: { name: "e2e", platform: "linux" } });
    writeFileSync(arg1, JSON.stringify({ email, password, accessToken: login.accessToken }), { mode: 0o600 });
    break;
  }
  case "enroll": {
    const res = await call("POST", "/v1/devices", { name: "e2e client", platform: "linux", publicKey: arg2 }, load(arg1).accessToken);
    console.log(res.device.ipv4Address);
    break;
  }
  case "connected": {
    console.log((await call("GET", "/v1/connections", undefined, load(arg1).accessToken)).length);
    break;
  }
  case "delete": {
    const s = load(arg1);
    await call("DELETE", "/v1/users/me", { password: s.password }, s.accessToken);
    break;
  }
  case "node-key": {
    const list = JSON.parse(Buffer.from((await call("GET", "/v1/servers/relays")).payload, "base64").toString("utf8"));
    console.log(list.servers.find((s) => s.id === arg1)?.wireguard?.publicKey ?? "");
    break;
  }
  default:
    console.error("usage: account.mjs create|enroll|connected|delete|node-key …");
    process.exit(2);
}
