import { open, stat } from 'node:fs/promises'
import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceRoot, normalizeExplorerPath, resolveExplorerPath, validateAuthToken } from '../_utils'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_PREVIEW_BYTES = 200_000
const BINARY_DETECTION_BYTES = 12_000

function looksBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return false
  }

  if (buffer.includes(0)) {
    return true
  }

  const text = buffer.toString('utf8')
  if (!text) {
    return false
  }

  let replacementCharacters = 0
  for (const char of text) {
    if (char === '\uFFFD') {
      replacementCharacters += 1
    }
  }

  return replacementCharacters > Math.max(2, Math.floor(text.length * 0.02))
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error == null || !('code' in error)) {
    return undefined
  }

  const value = (error as { code?: unknown }).code
  return typeof value === 'string' ? value : undefined
}

export async function GET(request: NextRequest) {
  if (!validateAuthToken(request)) {
    return NextResponse.json(
      { error: 'Unauthorized - invalid or missing X-Auth-Token' },
      { status: 401 },
    )
  }

  try {
    const workspaceRoot = await getWorkspaceRoot()
    const relativePath = normalizeExplorerPath(request.nextUrl.searchParams.get('path'))
    if (!relativePath) {
      return NextResponse.json({ error: 'A file path is required' }, { status: 400 })
    }

    const absolutePath = resolveExplorerPath(relativePath, workspaceRoot)
    const fileStat = await stat(absolutePath)

    if (!fileStat.isFile()) {
      return NextResponse.json({ error: 'Path is not a file' }, { status: 400 })
    }

    const bytesToRead = Math.min(fileStat.size, MAX_PREVIEW_BYTES)
    const handle = await open(absolutePath, 'r')

    try {
      const previewBuffer = Buffer.alloc(bytesToRead)
      if (bytesToRead > 0) {
        await handle.read(previewBuffer, 0, bytesToRead, 0)
      }

      const binarySample = previewBuffer.subarray(0, Math.min(previewBuffer.length, BINARY_DETECTION_BYTES))
      const binary = looksBinary(binarySample)

      return NextResponse.json({
        path: relativePath,
        content: binary ? null : previewBuffer.toString('utf8'),
        binary,
        truncated: fileStat.size > MAX_PREVIEW_BYTES,
        size: fileStat.size,
      })
    } finally {
      await handle.close()
    }
  } catch (error) {
    const code = getErrorCode(error)
    if (code === 'ENOENT') {
      return NextResponse.json({ error: 'File not found' }, { status: 404 })
    }

    const message = error instanceof Error ? error.message : 'Failed to load file'
    const status = message === 'Invalid path' || message === 'Path is outside workspace' ? 400 : 500
    return NextResponse.json({ error: message }, { status })
  }
}

