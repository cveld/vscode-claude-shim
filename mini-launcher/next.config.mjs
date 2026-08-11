/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Allow Next.js to compile source files from the shared launcher/lib/ directory.
  // Without this, imports like `@/launcher-lib/claudeHome.ts` hit a "no loaders
  // configured" error because Next.js only compiles files inside the project root.
  experimental: {
    externalDir: true,
  },
};

export default nextConfig;