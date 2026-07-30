import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: process.cwd().endsWith('/apps/web')
    ? new URL('../..', import.meta.url).pathname
    : process.cwd(),
  typedRoutes: true,
  allowedDevOrigins: ['127.0.0.1'],
};

export default nextConfig;
