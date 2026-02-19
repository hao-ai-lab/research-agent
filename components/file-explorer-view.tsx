'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  FileCode2,
  Folder,
  FolderOpen,
  Loader2,
  PanelLeftOpen,
  RefreshCcw,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { getApiUrl, getAuthToken, getResearchAgentKey } from '@/lib/api-config'

type ExplorerNodeType = 'file' | 'directory'

interface ExplorerNode {
  name: string
  path: string
  type: ExplorerNodeType
  hidden: boolean
}

interface ExplorerTreeResponse {
  path: string
  entries: ExplorerNode[]
}

interface ExplorerFileResponse {
  path: string
  content: string | null
  binary: boolean
  truncated: boolean
  size: number
}

type PreviewState = 'idle' | 'loading' | 'ready' | 'error'

async function parseErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown }
    if (typeof payload.error === 'string' && payload.error.trim()) {
      return payload.error
    }
  } catch {
    // Ignore parse errors and use fallback.
  }

  return fallback
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function getFileName(path: string | null): string {
  if (!path) return 'No file selected'
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}

interface FileExplorerViewProps {
  showDesktopSidebarToggle?: boolean
  onDesktopSidebarToggle?: () => void
}

export function FileExplorerView({
  showDesktopSidebarToggle = false,
  onDesktopSidebarToggle,
}: FileExplorerViewProps) {
  const [treeByPath, setTreeByPath] = useState<Record<string, ExplorerNode[]>>({})
  const treeByPathRef = useRef<Record<string, ExplorerNode[]>>({})
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set())
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set())
  const [treeError, setTreeError] = useState<string | null>(null)

  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const [filePreview, setFilePreview] = useState<ExplorerFileResponse | null>(null)
  const [previewState, setPreviewState] = useState<PreviewState>('idle')
  const [fileError, setFileError] = useState<string | null>(null)
  const [mobileMode, setMobileMode] = useState<'tree' | 'preview'>('tree')

  useEffect(() => {
    treeByPathRef.current = treeByPath
  }, [treeByPath])

  const loadDirectory = useCallback(async (directoryPath: string, force = false) => {
    if (!force && Object.prototype.hasOwnProperty.call(treeByPathRef.current, directoryPath)) {
      return
    }

    setLoadingDirs((prev) => {
      const next = new Set(prev)
      next.add(directoryPath)
      return next
    })
    if (directoryPath === '') {
      setTreeError(null)
    }

    try {
      const headers: HeadersInit = {
        'X-Auth-Token': getAuthToken(),
        'X-Backend-Url': getApiUrl(),
      }
      const researchAgentKey = getResearchAgentKey()
      if (researchAgentKey) {
        headers['X-Research-Agent-Key'] = researchAgentKey
      }

      const response = await fetch(`/api/file-explorer/tree?path=${encodeURIComponent(directoryPath)}`, {
        cache: 'no-store',
        headers,
      })

      if (!response.ok) {
        const message = await parseErrorMessage(response, 'Failed to load file tree')
        throw new Error(message)
      }

      const payload = (await response.json()) as ExplorerTreeResponse
      setTreeByPath((prev) => ({
        ...prev,
        [directoryPath]: payload.entries,
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load file tree'
      if (directoryPath === '') {
        setTreeError(message)
      }
    } finally {
      setLoadingDirs((prev) => {
        const next = new Set(prev)
        next.delete(directoryPath)
        return next
      })
    }
  }, [])

  const loadFile = useCallback(async (filePath: string, force = false) => {
    const sameFile = filePreview?.path === filePath && previewState === 'ready'
    setSelectedFilePath(filePath)
    if (!force && sameFile) {
      return
    }

    setPreviewState('loading')
    setFileError(null)

    try {
      const headers: HeadersInit = {
        'X-Auth-Token': getAuthToken(),
        'X-Backend-Url': getApiUrl(),
      }
      const researchAgentKey = getResearchAgentKey()
      if (researchAgentKey) {
        headers['X-Research-Agent-Key'] = researchAgentKey
      }

      const response = await fetch(`/api/file-explorer/file?path=${encodeURIComponent(filePath)}`, {
        cache: 'no-store',
        headers,
      })

      if (!response.ok) {
        const message = await parseErrorMessage(response, 'Failed to load file')
        throw new Error(message)
      }

      const payload = (await response.json()) as ExplorerFileResponse
      setFilePreview(payload)
      setPreviewState('ready')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load file'
      setPreviewState('error')
      setFileError(message)
    }
  }, [filePreview?.path, previewState])

  useEffect(() => {
    void loadDirectory('', true)
  }, [loadDirectory])

  const handleDirectoryToggle = useCallback((directoryPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(directoryPath)) {
        next.delete(directoryPath)
      } else {
        next.add(directoryPath)
      }
      return next
    })

    if (!Object.prototype.hasOwnProperty.call(treeByPathRef.current, directoryPath)) {
      void loadDirectory(directoryPath)
    }
  }, [loadDirectory])

  const handleSelectFile = useCallback((filePath: string) => {
    setMobileMode('preview')
    void loadFile(filePath)
  }, [loadFile])

  const handleRefresh = useCallback(() => {
    setTreeByPath({})
    treeByPathRef.current = {}
    setExpandedDirs(new Set())
    setTreeError(null)
    void loadDirectory('', true)

    if (selectedFilePath) {
      void loadFile(selectedFilePath, true)
    }
  }, [loadDirectory, loadFile, selectedFilePath])

  const previewLines = useMemo(() => {
    if (!filePreview?.content) {
      return []
    }
    return filePreview.content.split('\n')
  }, [filePreview?.content])

  const renderTreeNodes = useCallback((parentPath: string, depth: number): ReactNode => {
    const entries = treeByPath[parentPath] || []
    if (entries.length === 0) {
      return null
    }

    return entries.map((entry) => {
      const leftPadding = 10 + depth * 14
      const isSelected = selectedFilePath === entry.path

      if (entry.type === 'directory') {
        const isExpanded = expandedDirs.has(entry.path)
        const isLoading = loadingDirs.has(entry.path)
        const childEntries = treeByPath[entry.path] || []

        return (
          <div key={entry.path}>
            <button
              type="button"
              onClick={() => handleDirectoryToggle(entry.path)}
              className="w-full text-left"
            >
              <div
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-secondary/70',
                  isExpanded && 'bg-secondary/40'
                )}
                style={{ paddingLeft: `${leftPadding}px` }}
              >
                {isExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                {isExpanded ? (
                  <FolderOpen className="h-4 w-4 shrink-0 text-primary" />
                ) : (
                  <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className={cn('truncate', entry.hidden && 'text-muted-foreground')}>
                  {entry.name}
                </span>
              </div>
            </button>

            {isExpanded && isLoading && (
              <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground" style={{ paddingLeft: `${leftPadding + 18}px` }}>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading...
              </div>
            )}

            {isExpanded && !isLoading && childEntries.length === 0 && (
              <div className="px-2 py-1.5 text-xs text-muted-foreground" style={{ paddingLeft: `${leftPadding + 18}px` }}>
                Empty folder
              </div>
            )}

            {isExpanded && !isLoading && renderTreeNodes(entry.path, depth + 1)}
          </div>
        )
      }

      return (
        <button
          key={entry.path}
          type="button"
          onClick={() => handleSelectFile(entry.path)}
          className="w-full text-left"
        >
          <div
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-secondary/70',
              isSelected && 'bg-secondary text-foreground'
            )}
            style={{ paddingLeft: `${leftPadding + 16}px` }}
          >
            <FileCode2 className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className={cn('truncate', entry.hidden && 'text-muted-foreground')}>
              {entry.name}
            </span>
          </div>
        </button>
      )
    })
  }, [expandedDirs, handleDirectoryToggle, handleSelectFile, loadingDirs, selectedFilePath, treeByPath])

  const selectedFileName = getFileName(selectedFilePath)
  const rootLoading = loadingDirs.has('')
  const rootEntries = treeByPath[''] || []

  const treePane = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border/70 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          {showDesktopSidebarToggle && onDesktopSidebarToggle && (
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={onDesktopSidebarToggle}
              className="hidden h-9 w-9 shrink-0 border-border/70 bg-card text-muted-foreground hover:bg-secondary lg:inline-flex"
              title="Show sidebar"
            >
              <PanelLeftOpen className="h-4 w-4" />
              <span className="sr-only">Show sidebar</span>
            </Button>
          )}
          <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">File Explorer</p>
          <p className="text-[11px] text-muted-foreground">Hidden files included</p>
        </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={handleRefresh}
          title="Refresh file tree"
        >
          <RefreshCcw className={cn('h-3.5 w-3.5', rootLoading && 'animate-spin')} />
          <span className="sr-only">Refresh file tree</span>
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1 px-2 py-2">
        {treeError ? (
          <div className="mx-1 flex flex-col gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <p>{treeError}</p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void loadDirectory('', true)}
              className="h-7 w-fit"
            >
              Retry
            </Button>
          </div>
        ) : null}

        {!treeError && rootLoading && rootEntries.length === 0 && (
          <div className="mx-1 flex items-center gap-2 rounded-md border border-border/70 bg-card/70 px-3 py-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading workspace files...
          </div>
        )}

        {!treeError && !rootLoading && rootEntries.length === 0 && (
          <div className="mx-1 rounded-md border border-dashed border-border/80 bg-card/60 px-3 py-4 text-sm text-muted-foreground">
            No files found.
          </div>
        )}

        {!treeError && rootEntries.length > 0 && (
          <div className="space-y-0.5">
            {renderTreeNodes('', 0)}
          </div>
        )}
      </ScrollArea>
    </div>
  )

  const previewBody = (
    <ScrollArea className="min-h-0 flex-1 bg-card/20">
      {!selectedFilePath && (
        <div className="flex h-full min-h-[240px] flex-col items-center justify-center px-6 text-center">
          <FileCode2 className="mb-3 h-8 w-8 text-muted-foreground/70" />
          <p className="text-sm text-foreground">Select a file to preview it.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Browse folders on the left and pick any file.
          </p>
        </div>
      )}

      {selectedFilePath && previewState === 'loading' && (
        <div className="flex h-full min-h-[240px] items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading preview...
        </div>
      )}

      {selectedFilePath && previewState === 'error' && (
        <div className="mx-4 my-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          <div className="mb-2 flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>{fileError || 'Unable to load file preview.'}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              if (selectedFilePath) {
                void loadFile(selectedFilePath, true)
              }
            }}
          >
            Retry
          </Button>
        </div>
      )}

      {selectedFilePath && previewState === 'ready' && filePreview?.binary && (
        <div className="mx-4 my-4 rounded-md border border-border/70 bg-card/70 p-4 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Binary file preview is unavailable.</p>
          <p className="mt-1">This file appears to contain non-text data.</p>
        </div>
      )}

      {selectedFilePath && previewState === 'ready' && !filePreview?.binary && (
        <div className="min-w-full overflow-x-auto">
          <div className="min-w-full text-[12px] leading-5">
            {previewLines.map((line, index) => (
              <div key={`${selectedFilePath}:${index + 1}`} className="grid grid-cols-[auto_minmax(0,1fr)] border-b border-border/40">
                <span className="select-none border-r border-border/50 bg-background/70 px-3 py-0.5 text-right text-[10px] text-muted-foreground">
                  {index + 1}
                </span>
                <code className="block whitespace-pre px-3 py-0.5 font-mono text-foreground">
                  {line || ' '}
                </code>
              </div>
            ))}
          </div>
        </div>
      )}
    </ScrollArea>
  )

  const previewHeader = (mobile: boolean) => (
    <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2.5">
      {mobile && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          onClick={() => setMobileMode('tree')}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Files
        </Button>
      )}

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{selectedFileName}</p>
        <p className="truncate text-[11px] text-muted-foreground">{selectedFilePath || 'Choose a file from the tree'}</p>
      </div>

      {filePreview?.size != null && (
        <Badge variant="outline" className="h-6 rounded-full px-2 text-[10px]">
          {formatBytes(filePreview.size)}
        </Badge>
      )}

      {filePreview?.truncated && (
        <Badge variant="secondary" className="h-6 rounded-full px-2 text-[10px]">
          Truncated
        </Badge>
      )}
    </div>
  )

  return (
    <div className="mx-auto h-full w-full max-w-6xl overflow-hidden">
      <div className="hidden h-full min-h-0 md:flex">
        <aside className="h-full w-[340px] shrink-0 border-r border-border/70 bg-card/15">
          {treePane}
        </aside>
        <section className="min-w-0 flex-1">
          <div className="flex h-full min-h-0 flex-col">
            {previewHeader(false)}
            {previewBody}
          </div>
        </section>
      </div>

      <div className="flex h-full min-h-0 md:hidden">
        {mobileMode === 'tree' ? (
          <section className="min-w-0 flex-1">
            {treePane}
          </section>
        ) : (
          <section className="min-w-0 flex-1">
            <div className="flex h-full min-h-0 flex-col">
              {previewHeader(true)}
              {previewBody}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
