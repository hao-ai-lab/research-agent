'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { FolderOpen, FolderIcon, ChevronRight, ArrowUp, X, Check, Loader2 } from 'lucide-react'
import { listDirectories, type DirectoryEntry } from '@/lib/api-client'

interface WorkdirPickerProps {
    /** Currently selected workdir (null = server default) */
    value: string | null
    /** Callback when a workdir is confirmed */
    onSelect: (path: string | null) => void
    /** Disable interaction (e.g. after first message sent) */
    disabled?: boolean
}

export function WorkdirPicker({ value, onSelect, disabled }: WorkdirPickerProps) {
    const [isOpen, setIsOpen] = useState(false)
    const [currentPath, setCurrentPath] = useState('')
    const [dirs, setDirs] = useState<DirectoryEntry[]>([])
    const [serverWorkdir, setServerWorkdir] = useState('')
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [inputValue, setInputValue] = useState('')
    const inputRef = useRef<HTMLInputElement>(null)
    const panelRef = useRef<HTMLDivElement>(null)

    // Load directories for a path
    const loadDirs = useCallback(async (path?: string) => {
        setIsLoading(true)
        setError(null)
        try {
            const result = await listDirectories(path)
            setDirs(result.dirs)
            setCurrentPath(result.base_path)
            setInputValue(result.base_path)
            if (!serverWorkdir) {
                setServerWorkdir(result.server_workdir)
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load directories')
        } finally {
            setIsLoading(false)
        }
    }, [serverWorkdir])

    // Open the picker
    const handleOpen = useCallback(() => {
        if (disabled) return
        setIsOpen(true)
        loadDirs(value || undefined)
        setTimeout(() => inputRef.current?.focus(), 100)
    }, [disabled, value, loadDirs])

    // Close picker clicking outside
    useEffect(() => {
        if (!isOpen) return
        const handleClickOutside = (e: MouseEvent) => {
            if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
                setIsOpen(false)
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [isOpen])

    // Navigate into a subdirectory
    const navigateInto = useCallback((path: string) => {
        loadDirs(path)
    }, [loadDirs])

    // Navigate up one level
    const navigateUp = useCallback(() => {
        const parent = currentPath.replace(/\/[^/]+\/?$/, '') || '/'
        loadDirs(parent)
    }, [currentPath, loadDirs])

    // Confirm selection
    const handleConfirm = useCallback(() => {
        onSelect(currentPath || null)
        setIsOpen(false)
    }, [currentPath, onSelect])

    // Clear selection — go back to server default
    const handleClear = useCallback(() => {
        onSelect(null)
        setIsOpen(false)
    }, [onSelect])

    // Handle input path changes (autocomplete on Enter)
    const handleInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            e.preventDefault()
            const val = inputValue.trim()
            if (val) {
                loadDirs(val)
            }
        } else if (e.key === 'Escape') {
            setIsOpen(false)
        }
    }, [inputValue, loadDirs])

    // Derive display label
    const displayLabel = value
        ? value.split('/').filter(Boolean).pop() || value
        : null

    return (
        <div className="relative">
            {/* Trigger button */}
            <button
                type="button"
                onClick={handleOpen}
                disabled={disabled}
                className={`chat-toolbar-pill flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-colors ${value
                        ? 'border border-emerald-500/35 bg-emerald-500/15 text-emerald-700 dark:border-emerald-400/50 dark:bg-emerald-500/24 dark:text-emerald-300'
                        : 'border border-border/60 bg-secondary text-muted-foreground shadow-sm hover:bg-secondary/80 hover:text-foreground'
                    } ${disabled ? 'cursor-default opacity-60' : ''}`}
                title={value ? `Working directory: ${value}` : 'Set working directory'}
            >
                <FolderOpen className="h-3 w-3" />
                {displayLabel || 'Workdir'}
            </button>

            {/* Picker panel */}
            {isOpen && (
                <div
                    ref={panelRef}
                    className="absolute bottom-full left-0 mb-2 z-50 w-80 rounded-xl border border-border bg-card shadow-2xl overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-150"
                >
                    {/* Header */}
                    <div className="flex items-center justify-between border-b border-border px-3 py-2">
                        <h3 className="text-xs font-semibold text-foreground">Working Directory</h3>
                        <button
                            type="button"
                            onClick={() => setIsOpen(false)}
                            className="rounded-md p-0.5 text-muted-foreground hover:text-foreground transition-colors"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    </div>

                    {/* Path input */}
                    <div className="border-b border-border px-3 py-2">
                        <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary/50 px-2.5 py-1.5">
                            <FolderIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <input
                                ref={inputRef}
                                type="text"
                                value={inputValue}
                                onChange={(e) => setInputValue(e.target.value)}
                                onKeyDown={handleInputKeyDown}
                                placeholder="Enter path..."
                                className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
                            />
                            {isLoading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                        </div>
                        <p className="mt-1 text-[10px] text-muted-foreground">
                            Press Enter to navigate · Server default: <span className="font-medium">{serverWorkdir || '...'}</span>
                        </p>
                    </div>

                    {/* Directory list */}
                    <div className="max-h-48 overflow-y-auto py-1">
                        {error ? (
                            <div className="px-3 py-3 text-xs text-destructive">{error}</div>
                        ) : (
                            <>
                                {/* Navigate up */}
                                {currentPath && currentPath !== '/' && (
                                    <button
                                        type="button"
                                        onClick={navigateUp}
                                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-secondary/70"
                                    >
                                        <ArrowUp className="h-3.5 w-3.5 text-muted-foreground" />
                                        <span className="text-muted-foreground">..</span>
                                    </button>
                                )}

                                {dirs.length === 0 && !isLoading ? (
                                    <div className="px-3 py-3 text-xs text-muted-foreground">No subdirectories</div>
                                ) : (
                                    dirs.map((dir) => (
                                        <button
                                            key={dir.path}
                                            type="button"
                                            onClick={() => navigateInto(dir.path)}
                                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-secondary/70 group"
                                        >
                                            <FolderIcon className="h-3.5 w-3.5 text-amber-500/80" />
                                            <span className="flex-1 truncate text-foreground">{dir.name}</span>
                                            <ChevronRight className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                                        </button>
                                    ))
                                )}
                            </>
                        )}
                    </div>

                    {/* Footer: confirm / clear */}
                    <div className="flex items-center justify-between border-t border-border px-3 py-2">
                        <button
                            type="button"
                            onClick={handleClear}
                            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                        >
                            Reset to default
                        </button>
                        <button
                            type="button"
                            onClick={handleConfirm}
                            className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                        >
                            <Check className="h-3 w-3" />
                            Select
                        </button>
                    </div>
                </div>
            )}
        </div>
    )
}
