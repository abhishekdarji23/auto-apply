import type { NextConfig } from "next";
import { loadUserEnv } from "./src/lib/userConfig";

loadUserEnv();

const configuredPort = process.env.PORT;
const defaultDistDir = configuredPort && configuredPort !== "3000" ? `.next-${configuredPort}` : ".next";

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR || defaultDistDir,
  output: "standalone",
  logging: {
    fetches: { fullUrl: false },
    incomingRequests: false,
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**",
      },
    ],
  },
};

export default nextConfig;
