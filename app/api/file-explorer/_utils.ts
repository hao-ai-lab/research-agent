import path from 'node:path'

/**
 * Workspace root — the user's project directory.
 *
 * Resolution order:
 *  1. RESEARCH_AGENT_WORKDIR env var (set by the launcher script)
 *  2. Fetch from the Python backend's /health endpoint (returns { workdir })
 *  3. Fallback to process.cwd()
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

  // 3. Fallback
  _cachedWorkspaceRoot = path.resolve(process.cwd())
  return _cachedWorkspaceRoot
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
