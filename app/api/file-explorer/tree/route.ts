import { readdir } from 'node:fs/promises'
import { NextRequest, NextResponse } from 'next/server'
import {
  getWorkspaceRoot,
  joinExplorerPath,
  normalizeExplorerPath,
  resolveExplorerPath,
  type ExplorerTreeEntry,
} from '../_utils'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const nameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

function sortTreeEntries(a: ExplorerTreeEntry, b: ExplorerTreeEntry): number {
  if (a.type !== b.type) {
    return a.type === 'directory' ? -1 : 1
  }

  return nameCollator.compare(a.name, b.name)
}

export async function GET(request: NextRequest) {
  try {
    const workspaceRoot = await getWorkspaceRoot()
    const relativePath = normalizeExplorerPath(request.nextUrl.searchParams.get('path'))
    const absolutePath = resolveExplorerPath(relativePath, workspaceRoot)
    const dirEntries = await readdir(absolutePath, { withFileTypes: true })

    const entries: ExplorerTreeEntry[] = dirEntries
      .filter((entry) => entry.name !== '.' && entry.name !== '..')
      .map((entry): ExplorerTreeEntry => ({
        name: entry.name,
        path: joinExplorerPath(relativePath, entry.name),
        type: entry.isDirectory() ? 'directory' : 'file',
        hidden: entry.name.startsWith('.'),
      }))
      .sort(sortTreeEntries)

    return NextResponse.json({
      path: relativePath,
      entries,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load directory'
    const status = message === 'Invalid path' || message === 'Path is outside workspace' ? 400 : 500
    return NextResponse.json({ error: message }, { status })
  }
}

