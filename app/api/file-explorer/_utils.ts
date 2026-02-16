import path from 'node:path'
import type { NextRequest } from 'next/server'

/**
 * Workspace root — the user's project directory.
 *
 * Resolution order:
 *  1. RESEARCH_AGENT_WORKDIR env var (set by the launcher script)
 *  2. Fetch from the Python backend's /health endpoint (returns { workdir })
 *
 * If neither source provides a workdir, an error is thrown — we never
 * fall back to process.cwd() because that exposes the application
 * directory instead of the user's project.
 */

let _cachedWorkspaceRoot = ''

async function fetchWorkdirFromBackend(): Promise<string | null> {
  try {
    const backendUrl = process.env.RESEARCH_AGENT_BACKEND_URL || 'http://127.0.0.1:10000'
    const resp = await fetch(`${backendUrl}/health`, { signal: AbortSignal.timeout(2000) })
    if (resp.ok) {
      const data = (await resp.json()) as { workdir?: string }
      if (data.workdir) {
        return data.workdir
      }
    }
  } catch {
    // Backend not reachable — fall through
  }
  return null
}

export async function getWorkspaceRoot(): Promise<string> {
  if (_cachedWorkspaceRoot) return _cachedWorkspaceRoot

  // 1. Env var
  const envWorkdir = process.env.RESEARCH_AGENT_WORKDIR
  if (envWorkdir) {
    _cachedWorkspaceRoot = path.resolve(envWorkdir)
    return _cachedWorkspaceRoot
  }

  // 2. Backend /health
  const backendWorkdir = await fetchWorkdirFromBackend()
  if (backendWorkdir) {
    _cachedWorkspaceRoot = path.resolve(backendWorkdir)
    return _cachedWorkspaceRoot
  }

  // No fallback — refuse to serve the app directory by mistake
  throw new Error(
    'Cannot determine workspace root. Set RESEARCH_AGENT_WORKDIR or ensure the backend is running.',
  )
}

export interface ExplorerTreeEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  hidden: boolean
}

export function normalizeExplorerPath(rawPath: string | null): string {
  const value = (rawPath ?? '').trim().replace(/\\/g, '/')

  if (!value || value === '.' || value === '/') {
    return ''
  }

  const withoutLeadingSlash = value.replace(/^\/+/, '')
  const normalized = path.posix.normalize(withoutLeadingSlash)

  if (
    !normalized ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    throw new Error('Invalid path')
  }

  return normalized
}

export function resolveExplorerPath(relativePath: string, workspaceRoot: string): string {
  const absolutePath = path.resolve(workspaceRoot, relativePath)

  if (
    absolutePath !== workspaceRoot &&
    !absolutePath.startsWith(`${workspaceRoot}${path.sep}`)
  ) {
    throw new Error('Path is outside workspace')
  }

  return absolutePath
}

export function joinExplorerPath(parentPath: string, childName: string): string {
  return parentPath ? `${parentPath}/${childName}` : childName
}

/**
 * Validate the auth token on a file-explorer request.
 *
 * Mirrors the Python backend's auth_middleware: if
 * RESEARCH_AGENT_USER_AUTH_TOKEN is set, the request must carry a
 * matching X-Auth-Token header.  When no token is configured the
 * endpoint is open (same as the backend behaviour).
 */
export function validateAuthToken(request: NextRequest): boolean {
  const expected = process.env.RESEARCH_AGENT_USER_AUTH_TOKEN
  if (!expected) {
    return true // no token configured — open access
  }
  const provided = request.headers.get('X-Auth-Token') ?? ''
  return provided === expected
}
