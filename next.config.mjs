/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['@prisma/client', 'bcryptjs'],
  experimental: {
    serverActions: { bodySizeLimit: '5mb' },
  },
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
