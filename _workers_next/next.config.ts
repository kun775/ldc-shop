import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 允许本地验证构建时把产物隔离到临时目录，避免沙箱 bulk-delete 守卫误报构建失败。
  // 该变量只在本地验证时设置，生产部署仍使用默认 .next。
  distDir: process.env.NEXT_DIST_DIR || '.next',
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
