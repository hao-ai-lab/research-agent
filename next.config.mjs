/** @type {import('next').NextConfig} */
const isStaticExport = process.env.RESEARCH_AGENT_STATIC_EXPORT === 'true'
const backendUrl = process.env.BACKEND_URL || 'http://localhost:10000'

const nextConfig = {
  ...(isStaticExport ? { output: 'export', trailingSlash: true } : {}),
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // Proxy backend API routes to the Python server (used in Modal preview)
  ...(!isStaticExport ? {
    async rewrites() {
      return [
        // Backend API routes
        { source: '/health', destination: `${backendUrl}/health` },
        { source: '/sessions', destination: `${backendUrl}/sessions` },
        { source: '/sessions/:path*', destination: `${backendUrl}/sessions/:path*` },
        { source: '/chat', destination: `${backendUrl}/chat` },
        { source: '/runs', destination: `${backendUrl}/runs` },
        { source: '/runs/:path*', destination: `${backendUrl}/runs/:path*` },
        { source: '/alerts', destination: `${backendUrl}/alerts` },
        { source: '/alerts/:path*', destination: `${backendUrl}/alerts/:path*` },
        { source: '/wild-mode', destination: `${backendUrl}/wild-mode` },
        { source: '/wild/:path*', destination: `${backendUrl}/wild/:path*` },
        { source: '/cluster', destination: `${backendUrl}/cluster` },
        { source: '/cluster/:path*', destination: `${backendUrl}/cluster/:path*` },
        { source: '/git/:path*', destination: `${backendUrl}/git/:path*` },
        { source: '/sweeps', destination: `${backendUrl}/sweeps` },
        { source: '/sweeps/:path*', destination: `${backendUrl}/sweeps/:path*` },
        { source: '/prompt-skills', destination: `${backendUrl}/prompt-skills` },
        { source: '/prompt-skills/:path*', destination: `${backendUrl}/prompt-skills/:path*` },
        { source: '/settings', destination: `${backendUrl}/settings` },
        { source: '/settings/:path*', destination: `${backendUrl}/settings/:path*` },
      ]
    },
  } : {}),
}

export default nextConfig
