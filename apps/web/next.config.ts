import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  transpilePackages: [
    "@swarm/agents",
    "@swarm/connections",
    "@swarm/contracts",
    "@swarm/crypto",
    "@swarm/db",
    "@swarm/fly",
    "@swarm/google",
    "@swarm/hermes-config",
    "@swarm/identity",
    "@swarm/mail",
    "@swarm/usage",
  ],
  serverExternalPackages: ["postgres"],
  outputFileTracingRoot: new URL("../..", import.meta.url).pathname,
};

export default config;
