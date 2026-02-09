import path from 'node:path'

const WORKSPACE_ROOT = path.resolve(process.cwd())

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

export function resolveExplorerPath(relativePath: string): string {
  const absolutePath = path.resolve(WORKSPACE_ROOT, relativePath)

  if (
    absolutePath !== WORKSPACE_ROOT &&
    !absolutePath.startsWith(`${WORKSPACE_ROOT}${path.sep}`)
  ) {
    throw new Error('Path is outside workspace')
  }

  return absolutePath
}

export function joinExplorerPath(parentPath: string, childName: string): string {
  return parentPath ? `${parentPath}/${childName}` : childName
}

