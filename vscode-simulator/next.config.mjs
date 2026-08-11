/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    externalDir: true,
  },
  outputFileTracingRoot: new URL("../", import.meta.url).pathname,
  async rewrites() {
    return [
      // Serve the real extension webview assets under a real path prefix so the ES-module
      // entry (index.js) can resolve relative chunk imports (e.g. ./169.js -> /webview/169.js).
      // The underlying handler still enforces the root-bounded path check.
      { source: "/webview/:path*", destination: "/api/webview-asset?path=:path*" },
      // Serve the extension's resources/ dir (icons, logos) same-origin so the webview's
      // asset_uris_response URLs (rewritten by the facade's asWebviewUri) resolve.
      { source: "/resources/:path*", destination: "/api/webview-resource?path=:path*" },
    ];
  },
};

export default nextConfig;
