import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Tuned for a small box (1 vCPU, 2 GB). The build is the memory peak, not the running app, so
 * parallelism is capped and type checking is done separately (`pnpm typecheck`, CI) rather than
 * inside `next build` where it doubles peak memory.
 */
const cpus = Number(process.env.NEXT_BUILD_CPUS ?? 1);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['@prisma/client', 'bcryptjs'],
  outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)),
  poweredByHeader: false,
  compress: true,
  productionBrowserSourceMaps: false,
  experimental: {
    serverActions: { bodySizeLimit: '5mb' },
    // Keep the build single-threaded on a 1-vCPU server.
    cpus,
    workerThreads: false,
  },
  // Trim the client bundle: only the icons actually imported ship.
  compiler: { removeConsole: process.env.NODE_ENV === 'production' ? { exclude: ['error', 'warn'] } : false },
  typescript: { ignoreBuildErrors: process.env.SKIP_TYPE_CHECK === 'true' },
  eslint: { ignoreDuringBuilds: process.env.SKIP_TYPE_CHECK === 'true' },
};

export default nextConfig;
