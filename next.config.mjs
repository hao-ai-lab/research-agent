/** @type {import('next').NextConfig} */
// Avoid accidental static-export mode on Vercel where API routes are required.
const isStaticExport =
  process.env.RESEARCH_AGENT_STATIC_EXPORT === 'true' && process.env.VERCEL !== '1'

const nextConfig = {
  ...(isStaticExport ? { output: 'export', trailingSlash: true } : {}),
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
 
}

export default nextConfig
