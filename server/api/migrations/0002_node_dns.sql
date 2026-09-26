-- A node can name the resolver clients use for "VPN DNS". NULL means the
-- tunnel gateway (Meridian nodes run a resolver there); third-party nodes
-- that only route (e.g. the WireGuard demo server in development) set one.
ALTER TABLE fleet.servers ADD COLUMN wg_dns_ipv4 inet;
