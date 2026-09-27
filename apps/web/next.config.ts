import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const here = dirname(fileURLToPath(import.meta.url));

const config: NextConfig = {
  // A self-contained server (.next/standalone) for the container image.
  output: "standalone",
  // The monorepo root, so the standalone trace includes hoisted packages.
  outputFileTracingRoot: join(here, "../.."),
  poweredByHeader: false,
  reactStrictMode: true,
  // Development: the API's WEB_APP_URL is http://127.0.0.1:3000.
  allowedDevOrigins: ["127.0.0.1"],
  // The Content-Security-Policy is per request (it carries a nonce): see src/proxy.ts.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default config;
