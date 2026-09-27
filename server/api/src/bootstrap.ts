import type { Config } from "./config.js";
import { openDatabase } from "./db/client.js";
import { migrate } from "./db/migrate.js";
import type { AppDeps } from "./deps.js";
import { maxmindGeoIp, NoGeoIp } from "./lib/geoip.js";
import { ConsoleMailer, smtpMailer } from "./lib/mailer.js";
import { AgentProvisioner, WireGuardDemoProvisioner } from "./modules/devices/provisioner.js";
import { ActivePeers } from "./modules/nodes/activePeers.js";
import { PeerSetWatch } from "./modules/nodes/peerSet.js";
import { ManualBilling, StripeBilling } from "./modules/subscription/provider.js";
import { ed25519FromSeed } from "./security/keys.js";
import { SecretBox } from "./security/secretbox.js";

/** Wires concrete implementations to the interfaces the app depends on. */
export async function createDeps(config: Config, overrides: Partial<AppDeps> = {}): Promise<AppDeps> {
  const database = overrides.database ?? (await openDatabase(config.DATABASE_URL));
  await migrate(database);
  // Which Stripe price sells which plan; configuration is the source.
  for (const [plan, price] of [["monthly", config.STRIPE_PRICE_MONTHLY], ["annual", config.STRIPE_PRICE_ANNUAL]] as const) {
    if (price) await database.db.updateTable("billing.plans").set({ stripe_price_id: price }).where("id", "=", plan).execute();
  }
  return {
    config,
    database,
    keys: overrides.keys ?? { access: ed25519FromSeed(config.ACCESS_TOKEN_SEED), relay: ed25519FromSeed(config.RELAY_SIGNING_SEED) },
    box: overrides.box ?? new SecretBox(config.DATA_ENCRYPTION_KEY),
    mailer: overrides.mailer ?? (config.MAIL_TRANSPORT === "smtp" ? smtpMailer(config.SMTP_URL!, config.MAIL_FROM!) : new ConsoleMailer()),
    billing:
      overrides.billing ??
      (config.BILLING_PROVIDER === "stripe"
        ? new StripeBilling({ secretKey: config.STRIPE_SECRET_KEY!, webhookSecret: config.STRIPE_WEBHOOK_SECRET! })
        : new ManualBilling()),
    geoip: overrides.geoip ?? (config.GEOIP_PROVIDER === "maxmind" ? maxmindGeoIp(config.MAXMIND_DB_PATH) : new NoGeoIp()),
    provisioner:
      overrides.provisioner ?? (config.NODE_PROVISIONING === "wireguard-demo" ? new WireGuardDemoProvisioner() : new AgentProvisioner()),
    activePeers: overrides.activePeers ?? new ActivePeers(),
    peerSet: overrides.peerSet ?? new PeerSetWatch(),
    now: overrides.now ?? (() => new Date()),
  };
}
