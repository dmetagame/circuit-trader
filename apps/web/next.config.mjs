import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["circuit-trader-policy", "@circuit-trader/connectors"],
  // Pin file tracing to the monorepo root (silences the multi-lockfile warning).
  outputFileTracingRoot: join(__dirname, "../../"),
};

export default nextConfig;
