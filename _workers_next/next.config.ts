import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  // Cache Components are unreliable on Workers (dummy cache + setTimeout warnings)
  cacheComponents: false,
  images: {
    // Product URLs are admin-configurable; render them directly instead of using the
    // server-side optimizer as an unrestricted fetch proxy.
    unoptimized: true,
    dangerouslyAllowSVG: false,
  },
  async rewrites() {
    return [
      {
        source: '/authcallback',
        destination: '/api/auth/callback/linuxdo',
      },
      {
        source: '/favicon.ico',
        destination: '/favicon',
      },
    ]
  },
};

export default nextConfig;
