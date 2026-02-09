'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, FileText, FolderTree, GitCompare, Loader2, RefreshCw, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { getRepoDiff, getRepoFile, getRepoFiles, type RepoDiffFile } from '@/lib/api-client'

type ExplorerMode = 'diff' | 'files'
type DiffFile = RepoDiffFile

type DirectoryNode = {
  kind: 'directory'
  name: string
  path: string
  children: TreeNode[]
}

type FileNode = {
  kind: 'file'
  name: string
  path: string
  diffFile?: DiffFile
}

type TreeNode = DirectoryNode | FileNode

interface ContextualDiffExplorerProps {
  files?: DiffFile[]
  onClose?: () => void
}

const DEFAULT_DIFF_FILES: DiffFile[] = [
  {
    path: 'app/contextual/page.tsx',
    status: 'modified',
    additions: 10,
    deletions: 2,
    lines: [
      { type: 'hunk', text: '@@ -62,6 +62,7 @@', oldLine: null, newLine: null },
      { type: 'context', text: '  const [showContextPanel, setShowContextPanel] = useState(true)', oldLine: 66, newLine: 66 },
      { type: 'add', text: '  const [diffExplorerOpen, setDiffExplorerOpen] = useState(false)', oldLine: null, newLine: 67 },
    ],
  },
  {
    path: 'components/contextual-diff-explorer.tsx',
    status: 'added',
    additions: 60,
    deletions: 0,
    lines: [
      { type: 'hunk', text: '@@ -0,0 +1,60 @@', oldLine: null, newLine: null },
      { type: 'add', text: "'use client'", oldLine: null, newLine: 1 },
      { type: 'add', text: 'export function ContextualDiffExplorer() {', oldLine: null, newLine: 12 },
    ],
  },
]

function statusBadgeClass(status: DiffFile['status']) {
  if (status === 'added') return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  if (status === 'deleted') return 'border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300'
  return 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
}

function lineRowTone(type: DiffFile['lines'][number]['type']) {
  if (type === 'add') return 'bg-emerald-500/10'
  if (type === 'remove') return 'bg-rose-500/10'
  if (type === 'hunk') return 'bg-primary/10'
  return 'bg-transparent'
}

function lineTextTone(type: DiffFile['lines'][number]['type']) {
  if (type === 'add') return 'text-emerald-700 dark:text-emerald-300'
  if (type === 'remove') return 'text-rose-700 dark:text-rose-300'
  if (type === 'hunk') return 'text-primary'
  return 'text-foreground'
}

function buildTree(paths: string[], diffByPath?: Map<string, DiffFile>): DirectoryNode {
  const root: DirectoryNode = { kind: 'directory', name: '', path: '', children: [] }

  paths.forEach((fullPath) => {
    const parts = fullPath.split('/')
    let current = root

    parts.forEach((part, index) => {
      const isFile = index === parts.length - 1
      const nodePath = parts.slice(0, index + 1).join('/')

      if (isFile) {
        if (!current.children.find((child) => child.kind === 'file' && child.path === nodePath)) {
          current.children.push({
            kind: 'file',
            name: part,
            path: nodePath,
            diffFile: diffByPath?.get(nodePath),
          })
        }
        return
      }

      let directory = current.children.find(
        (child): child is DirectoryNode => child.kind === 'directory' && child.path === nodePath
      )

      if (!directory) {
        directory = { kind: 'directory', name: part, path: nodePath, children: [] }
        current.children.push(directory)
      }

      current = directory
    })
  })

  const sortTree = (node: DirectoryNode) => {
    node.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    node.children.forEach((child) => {
      if (child.kind === 'directory') sortTree(child)
    })
  }

  sortTree(root)
  return root
}

export function ContextualDiffExplorer({ files = DEFAULT_DIFF_FILES, onClose }: ContextualDiffExplorerProps) {
  const [mode, setMode] = useState<ExplorerMode>('diff')
  const [collapsedDirectories, setCollapsedDirectories] = useState<Record<string, boolean>>({})

  const [apiDiffFiles, setApiDiffFiles] = useState<DiffFile[] | null>(null)
  const [diffError, setDiffError] = useState(false)
  const [diffLoading, setDiffLoading] = useState(false)
  const [selectedDiffPath, setSelectedDiffPath] = useState(files[0]?.path ?? '')

  const [repoFilePaths, setRepoFilePaths] = useState<string[]>([])
  const [repoFilesLoading, setRepoFilesLoading] = useState(false)
  const [repoFilesError, setRepoFilesError] = useState(false)
  const [selectedRepoPath, setSelectedRepoPath] = useState('')
  const [repoFileContent, setRepoFileContent] = useState('')
  const [repoFileBinary, setRepoFileBinary] = useState(false)
  const [repoFileTruncated, setRepoFileTruncated] = useState(false)
  const [repoFileLoading, setRepoFileLoading] = useState(false)

  const usesInternalDiffSource = files === DEFAULT_DIFF_FILES

  const loadDiffFiles = useCallback(async () => {
    if (!usesInternalDiffSource) return

    setDiffLoading(true)
    try {
      const response = await getRepoDiff(3)
      setApiDiffFiles(response.files)
      setDiffError(false)
    } catch (error) {
      console.error('Failed to load repo diff:', error)
      setDiffError(true)
    } finally {
      setDiffLoading(false)
    }
  }, [usesInternalDiffSource])

  const loadRepoPaths = useCallback(async () => {
    setRepoFilesLoading(true)
    try {
      const response = await getRepoFiles(5000)
      setRepoFilePaths(response.files)
      setRepoFilesError(false)
    } catch (error) {
      console.error('Failed to load repo files:', error)
      setRepoFilesError(true)
    } finally {
      setRepoFilesLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!usesInternalDiffSource) return

    let active = true
    const load = async () => {
      if (!active) return
      await loadDiffFiles()
    }

    load()
    const intervalId = window.setInterval(load, 8000)

    return () => {
      active = false
      window.clearInterval(intervalId)
    }
  }, [loadDiffFiles, usesInternalDiffSource])

  useEffect(() => {
    if (mode !== 'files') return

    let active = true
    const load = async () => {
      if (!active) return
      await loadRepoPaths()
    }

    load()
    const intervalId = window.setInterval(load, 20000)

    return () => {
      active = false
      window.clearInterval(intervalId)
    }
  }, [loadRepoPaths, mode])

  const effectiveDiffFiles = useMemo(() => {
    if (!usesInternalDiffSource) return files
    if (apiDiffFiles) return apiDiffFiles
    return diffError ? DEFAULT_DIFF_FILES : []
  }, [apiDiffFiles, diffError, files, usesInternalDiffSource])

  useEffect(() => {
    if (!effectiveDiffFiles.some((file) => file.path === selectedDiffPath)) {
      setSelectedDiffPath(effectiveDiffFiles[0]?.path ?? '')
    }
  }, [effectiveDiffFiles, selectedDiffPath])

  useEffect(() => {
    if (!repoFilePaths.some((path) => path === selectedRepoPath)) {
      setSelectedRepoPath(repoFilePaths[0] ?? '')
    }
  }, [repoFilePaths, selectedRepoPath])

  useEffect(() => {
    if (mode !== 'files' || !selectedRepoPath) return

    let active = true
    const loadFile = async () => {
      setRepoFileLoading(true)
      try {
        const response = await getRepoFile(selectedRepoPath, 120000)
        if (!active) return
        setRepoFileContent(response.content)
        setRepoFileBinary(response.binary)
        setRepoFileTruncated(response.truncated)
      } catch (error) {
        if (!active) return
        console.error('Failed to load repo file:', error)
        setRepoFileContent('Unable to load file content.')
        setRepoFileBinary(false)
        setRepoFileTruncated(false)
      } finally {
        if (active) setRepoFileLoading(false)
      }
    }

    loadFile()

    return () => {
      active = false
    }
  }, [mode, selectedRepoPath])

  const selectedDiffFile = useMemo(
    () => effectiveDiffFiles.find((file) => file.path === selectedDiffPath) ?? null,
    [effectiveDiffFiles, selectedDiffPath]
  )

  const diffPathMap = useMemo(
    () => new Map(effectiveDiffFiles.map((file) => [file.path, file])),
    [effectiveDiffFiles]
  )

  const diffTree = useMemo(
    () => buildTree(effectiveDiffFiles.map((file) => file.path), diffPathMap),
    [effectiveDiffFiles, diffPathMap]
  )

  const fileTree = useMemo(
    () => buildTree(repoFilePaths),
    [repoFilePaths]
  )

  const totalAdditions = useMemo(
    () => effectiveDiffFiles.reduce((sum, file) => sum + file.additions, 0),
    [effectiveDiffFiles]
  )

  const totalDeletions = useMemo(
    () => effectiveDiffFiles.reduce((sum, file) => sum + file.deletions, 0),
    [effectiveDiffFiles]
  )

  const renderTree = (nodes: TreeNode[], depth = 0): ReactNode =>
    nodes.map((node) => {
      if (node.kind === 'directory') {
        const collapsed = Boolean(collapsedDirectories[node.path])
        return (
          <div key={node.path}>
            <button
              type="button"
              className="flex w-full items-center gap-1 rounded-md py-1 pr-2 text-left text-xs text-muted-foreground transition-colors hover:bg-secondary/70 hover:text-foreground"
              style={{ paddingLeft: `${8 + depth * 14}px` }}
              onClick={() =>
                setCollapsedDirectories((prev) => ({
                  ...prev,
                  [node.path]: !prev[node.path],
                }))
              }
            >
              {collapsed ? <ChevronRight className="h-3 w-3 shrink-0" /> : <ChevronDown className="h-3 w-3 shrink-0" />}
              <span className="truncate">{node.name}</span>
            </button>
            {!collapsed && <div>{renderTree(node.children, depth + 1)}</div>}
          </div>
        )
      }

      const isSelected = mode === 'diff'
        ? selectedDiffPath === node.path
        : selectedRepoPath === node.path

      return (
        <button
          key={node.path}
          type="button"
          onClick={() => {
            if (mode === 'diff') {
              setSelectedDiffPath(node.path)
            } else {
              setSelectedRepoPath(node.path)
            }
          }}
          className={`flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-xs transition-colors ${
            isSelected
              ? 'bg-primary/15 text-foreground'
              : 'text-muted-foreground hover:bg-secondary/70 hover:text-foreground'
          }`}
          style={{ paddingLeft: `${10 + depth * 14}px` }}
        >
          <FileText className="h-3 w-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          {mode === 'diff' && node.diffFile && (
            <>
              <span className="text-[10px] text-emerald-600">+{node.diffFile.additions}</span>
              <span className="text-[10px] text-rose-600">-{node.diffFile.deletions}</span>
            </>
          )}
        </button>
      )
    })

  const handleRefresh = useCallback(() => {
    if (mode === 'diff') {
      void loadDiffFiles()
    } else {
      void loadRepoPaths()
    }
  }, [loadDiffFiles, loadRepoPaths, mode])

  const loading = mode === 'diff' ? diffLoading : repoFilesLoading

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border/80 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">Git Explorer</p>
            <p className="text-[11px] text-muted-foreground">
              {mode === 'diff' ? 'Review changed files and hunks.' : 'Browse repository files and open contents.'}
            </p>
          </div>

          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant={mode === 'diff' ? 'default' : 'outline'}
              className="h-7 gap-1.5 px-2 text-xs"
              onClick={() => setMode('diff')}
            >
              <GitCompare className="h-3.5 w-3.5" />
              Diff
            </Button>
            <Button
              size="sm"
              variant={mode === 'files' ? 'default' : 'outline'}
              className="h-7 gap-1.5 px-2 text-xs"
              onClick={() => setMode('files')}
            >
              <FolderTree className="h-3.5 w-3.5" />
              Files
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={handleRefresh}
              title="Refresh explorer"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span className="sr-only">Refresh explorer</span>
            </Button>
            {onClose && (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={onClose}
                title="Close explorer"
              >
                <X className="h-3.5 w-3.5" />
                <span className="sr-only">Close explorer</span>
              </Button>
            )}
          </div>
        </div>
      </header>

      <div className="min-h-0 flex flex-1 overflow-hidden">
        <section className="flex min-w-0 flex-1 flex-col border-r border-border/80 bg-background/40">
          {mode === 'diff' ? (
            <>
              <header className="border-b border-border/80 px-3 py-2">
                <p className="truncate text-xs font-semibold text-foreground">
                  {selectedDiffFile?.path ?? 'Select a changed file'}
                </p>
                {selectedDiffFile && (
                  <div className="mt-1 flex items-center gap-1.5">
                    <Badge variant="outline" className={`h-4 px-1.5 text-[9px] uppercase ${statusBadgeClass(selectedDiffFile.status)}`}>
                      {selectedDiffFile.status}
                    </Badge>
                    <span className="text-[10px] text-emerald-600">+{selectedDiffFile.additions}</span>
                    <span className="text-[10px] text-rose-600">-{selectedDiffFile.deletions}</span>
                  </div>
                )}
              </header>

              <div className="min-h-0 flex-1 overflow-auto">
                {!selectedDiffFile ? (
                  <div className="p-4 text-xs text-muted-foreground">No changed file selected.</div>
                ) : (
                  <div className="min-w-[700px] font-mono text-[11px] leading-5">
                    {selectedDiffFile.lines.map((line, index) => (
                      <div
                        key={`${selectedDiffFile.path}-${index}`}
                        className={`grid grid-cols-[52px_52px_minmax(0,1fr)] border-b border-border/30 ${lineRowTone(line.type)}`}
                      >
                        <div className="border-r border-border/20 px-2 text-right text-muted-foreground">{line.oldLine ?? ''}</div>
                        <div className="border-r border-border/20 px-2 text-right text-muted-foreground">{line.newLine ?? ''}</div>
                        <div className={`px-2 whitespace-pre ${lineTextTone(line.type)}`}>
                          {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
                          {line.text}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <header className="border-b border-border/80 px-3 py-2">
                <p className="truncate text-xs font-semibold text-foreground">{selectedRepoPath || 'Select a repository file'}</p>
                <div className="mt-1 flex items-center gap-1.5">
                  {repoFileBinary && <Badge variant="outline" className="h-4 px-1.5 text-[9px] uppercase">binary</Badge>}
                  {repoFileTruncated && <Badge variant="outline" className="h-4 px-1.5 text-[9px] uppercase">truncated</Badge>}
                </div>
              </header>

              <div className="min-h-0 flex-1 overflow-auto bg-background/60">
                {!selectedRepoPath ? (
                  <div className="p-4 text-xs text-muted-foreground">No file selected.</div>
                ) : repoFileLoading ? (
                  <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading file...
                  </div>
                ) : repoFileBinary ? (
                  <div className="p-4 text-xs text-muted-foreground">Binary file preview is not supported.</div>
                ) : (
                  <pre className="min-w-full p-3 font-mono text-[11px] leading-5 whitespace-pre">{repoFileContent}</pre>
                )}
              </div>
            </>
          )}
        </section>

        <aside className="w-[280px] shrink-0 bg-card/80">
          <header className="border-b border-border/80 px-3 py-2">
            <p className="text-xs font-semibold text-foreground">{mode === 'diff' ? 'Changed Files' : 'Repository Files'}</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              {mode === 'diff' ? (
                <>
                  {effectiveDiffFiles.length} files · <span className="text-emerald-600">+{totalAdditions}</span>{' '}
                  <span className="text-rose-600">-{totalDeletions}</span>
                </>
              ) : (
                <>
                  {repoFilePaths.length} files
                  {repoFilesError && ' · failed to sync'}
                </>
              )}
            </p>
          </header>

          <div className="h-[calc(100%-49px)] overflow-y-auto px-1.5 py-1.5">
            {loading ? (
              <div className="flex items-center gap-2 px-2 py-1 text-[11px] text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading...
              </div>
            ) : mode === 'diff' && effectiveDiffFiles.length === 0 ? (
              <p className="px-2 py-1 text-[11px] text-muted-foreground">No changed files.</p>
            ) : mode === 'files' && repoFilePaths.length === 0 ? (
              <p className="px-2 py-1 text-[11px] text-muted-foreground">No repository files available.</p>
            ) : (
              renderTree(mode === 'diff' ? diffTree.children : fileTree.children)
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}
