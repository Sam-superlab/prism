import type { NextConfig } from 'next';
import { resolve } from 'node:path';
const config: NextConfig = {
  devIndicators: false,
  distDir: process.env.PRISM_NEXT_DIST_DIR || '.next',
  ...(process.env.PRISM_NEXT_STANDALONE === 'true'
    ? {
        output: 'standalone',
        outputFileTracingRoot: resolve('../..'),
        images: { unoptimized: true },
        // Desktop updates validate the program directory against its installation inventory.
        experimental: { isrFlushToDisk: false },
      }
    : {}),
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};
export default config;
