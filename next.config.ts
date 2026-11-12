import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // distDir قابل للتوجيه بمتغير بيئي — يسمح بتشغيل next build في مسار منفصل
  // دون تعطيل خادم التطوير الذي يعمل على .next الافتراضي
  distDir: process.env.NEXT_DIST_DIR || ".next",
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: false,
};

export default nextConfig;
