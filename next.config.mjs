/** @type {import('next').NextConfig} */
const isStaticExport = process.env.RESEARCH_AGENT_STATIC_EXPORT === 'true'

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
