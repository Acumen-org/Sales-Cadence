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
  // sanitize-html is loaded from node_modules at run time, so its own postcss comes with it. Bundled,
  // it left a bare require('postcss') behind, and postcss is only a dev dependency: the production
  // image prunes it and every page sharing that chunk crashed (14 Nov, MODULE_NOT_FOUND).
  serverExternalPackages: ['@prisma/client', 'bcryptjs', 'sanitize-html'],
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
  // T46: console.log is kept. Next strips it from server code as well as the browser's, and the
  // server's log lines are what there is to read during an incident.
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
