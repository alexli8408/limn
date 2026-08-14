/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship compiled ESM; Next still needs to be told to run
  // them through its own pipeline so they resolve inside the app's module graph.
  transpilePackages: ["@limn/protocol", "@limn/shapes"],
  eslint: { ignoreDuringBuilds: true },
  experimental: {
    // Excalidraw is a large client-only bundle; keeping it out of the server
    // graph avoids pulling canvas/DOM shims into the RSC build.
    optimizePackageImports: ["@excalidraw/excalidraw"],
  },
};

export default nextConfig;
