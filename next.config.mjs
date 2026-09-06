import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['@prisma/client', 'bcryptjs'],
  // Pin the tracing root to this repo so a stray lockfile in a parent folder is ignored.
  outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)),
  experimental: {
    serverActions: { bodySizeLimit: '5mb' },
  },
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
