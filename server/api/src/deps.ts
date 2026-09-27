import type { Config } from "./config.js";
import type { Database } from "./db/client.js";
import type { BillingProvider } from "./modules/subscription/provider.js";
import type { PeerProvisioner } from "./modules/devices/provisioner.js";
import type { GeoIp } from "./lib/geoip.js";
import type { Mailer } from "./lib/mailer.js";
import type { Ed25519Keys } from "./security/keys.js";
import type { SecretBox } from "./security/secretbox.js";
import type { ActivePeers } from "./modules/nodes/activePeers.js";
import type { PeerSetWatch } from "./modules/nodes/peerSet.js";

export interface AppDeps {
  config: Config;
  database: Database;
  keys: { access: Ed25519Keys; relay: Ed25519Keys };
  box: SecretBox;
  mailer: Mailer;
  billing: BillingProvider;
  geoip: GeoIp;
  provisioner: PeerProvisioner;
  activePeers: ActivePeers;
  /** The node peer set; call `changed()` after anything that may alter it. */
  peerSet: PeerSetWatch;
  now: () => Date;
}

declare module "fastify" {
  interface FastifyInstance {
    deps: AppDeps;
  }
}
