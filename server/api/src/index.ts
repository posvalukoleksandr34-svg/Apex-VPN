import { buildApp } from "./app.js";
import { createDeps } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { startJobs } from "./jobs.js";

const config = loadConfig();
const deps = await createDeps(config);
const app = await buildApp(deps, { logger: true });
const stopJobs = startJobs(deps, (m) => app.log.warn(m));

if (config.NODE_PROVISIONING === "wireguard-demo") {
  app.log.warn("DEVELOPMENT: devices are provisioned on demo.wireguard.com (a public test server). Never use in production.");
}

await app.listen({ host: config.HOST, port: config.PORT });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    stopJobs();
    await app.close();
    await deps.database.close();
    process.exit(0);
  });
}
