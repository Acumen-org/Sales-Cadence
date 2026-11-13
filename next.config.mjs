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
  distDir: process.env.NEXT_DIST_DIR || '.next',
  serverExternalPackages: ['@prisma/client', 'bcryptjs'],
  outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)),
  poweredByHeader: false,
  compress: true,
  productionBrowserSourceMaps: false,
  experimental: {
    serverActions: { bodySizeLimit: '5mb' },
    // A page the reader just left comes back from the client cache for half a minute; the version
    // poll and the live read refresh anything that moved.
    staleTimes: { dynamic: 30, static: 180 },
    // NODE_ENV=development next build, for chasing a hydration mismatch that production React
    // reports without its diff. Never set in a deployment.
    ...(process.env.ALLOW_DEV_BUILD === '1' ? { allowDevelopmentBuild: true } : {}),
    // Keep the build single-threaded on a 1-vCPU server.
    cpus,
    workerThreads: false,
  },
  // Trim the client bundle: only the icons actually imported ship.
  compiler: { removeConsole: process.env.NODE_ENV === 'production' ? { exclude: ['error', 'warn'] } : false },
  typescript: { ignoreBuildErrors: process.env.SKIP_TYPE_CHECK === 'true' },
  eslint: { ignoreDuringBuilds: process.env.SKIP_TYPE_CHECK === 'true' },
  // Audit Q16: security headers on every answer. The policy is deliberately narrow (no script-src:
  // Next's own inline scripts would need nonces): no other site may frame Cadence, no plugins, no
  // <base> rewriting. HSTS is ignored by browsers on plain http, so local runs are unaffected.
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'Content-Security-Policy', value: "frame-ancestors 'self'; base-uri 'self'; object-src 'none'" },
        { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
      ],
    }];
  },
};

export default nextConfig;
