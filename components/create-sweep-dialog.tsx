'use client'

import { useState } from 'react'
import {
    Repeat,
    Plus,
    Trash2,
    Play,
    X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { createSweep, type CreateSweepRequest } from '@/lib/api'

interface CreateSweepDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    baseCommand?: string
    onSweepCreated?: (sweepId: string, runCount: number) => void
}

interface ParameterEntry {
    key: string
    values: string
}

export function CreateSweepDialog({
    open,
    onOpenChange,
    baseCommand = '',
    onSweepCreated,
}: CreateSweepDialogProps) {
    const [name, setName] = useState('')
    const [command, setCommand] = useState(baseCommand)
    const [parameters, setParameters] = useState<ParameterEntry[]>([
        { key: '', values: '' }
    ])
    const [maxRuns, setMaxRuns] = useState('10')
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)

    // Reset form when dialog opens
    const handleOpenChange = (newOpen: boolean) => {
        if (newOpen) {
            setName('')
            setCommand(baseCommand)
            setParameters([{ key: '', values: '' }])
            setMaxRuns('10')
            setError(null)
        }
        onOpenChange(newOpen)
    }

    const addParameter = () => {
        setParameters([...parameters, { key: '', values: '' }])
    }

    const removeParameter = (index: number) => {
        setParameters(parameters.filter((_, i) => i !== index))
    }

    const updateParameter = (index: number, field: 'key' | 'values', value: string) => {
        const newParams = [...parameters]
        newParams[index][field] = value
        setParameters(newParams)
    }

    const parseParameterValues = (values: string): unknown[] => {
        // Parse comma-separated values, trying to parse as numbers
        return values.split(',').map(v => {
            const trimmed = v.trim()
            const num = Number(trimmed)
            return isNaN(num) ? trimmed : num
        }).filter(v => v !== '')
    }

    const handleCreate = async (autoStart: boolean = false) => {
        setError(null)

        if (!name.trim()) {
            setError('Name is required')
            return
        }
        if (!command.trim()) {
            setError('Command is required')
            return
        }

        // Build parameters object
        const paramObj: Record<string, unknown[]> = {}
        for (const param of parameters) {
            if (param.key.trim() && param.values.trim()) {
                paramObj[param.key.trim()] = parseParameterValues(param.values)
            }
        }

        if (Object.keys(paramObj).length === 0) {
            setError('At least one parameter is required')
            return
        }

        setIsSubmitting(true)
        try {
            const request: CreateSweepRequest = {
                name: name.trim(),
                base_command: command.trim(),
                parameters: paramObj,
                max_runs: parseInt(maxRuns) || 10,
                auto_start: autoStart,
            }

            const sweep = await createSweep(request)
            onSweepCreated?.(sweep.id, sweep.run_ids.length)
            onOpenChange(false)
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to create sweep')
        } finally {
            setIsSubmitting(false)
        }
    }

    // Calculate expected run count
    const getExpectedRunCount = () => {
        let count = 1
        for (const param of parameters) {
            if (param.key.trim() && param.values.trim()) {
                const vals = parseParameterValues(param.values)
                count *= vals.length
            }
        }
        return Math.min(count, parseInt(maxRuns) || 10)
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="max-w-md max-h-[85vh] flex flex-col">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Repeat className="h-5 w-5" />
                        Create Sweep
                    </DialogTitle>
                    <DialogDescription>
                        Create a parameter sweep with multiple runs
                    </DialogDescription>
                </DialogHeader>

                <ScrollArea className="flex-1 -mx-6 px-6">
                    <div className="space-y-4 pb-4">
                        {/* Name */}
                        <div className="space-y-2">
                            <Label htmlFor="sweep-name">Sweep Name</Label>
                            <Input
                                id="sweep-name"
                                placeholder="e.g., Learning Rate Sweep"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                            />
                        </div>

                        {/* Command */}
                        <div className="space-y-2">
                            <Label htmlFor="sweep-command">Base Command</Label>
                            <Textarea
                                id="sweep-command"
                                placeholder="python train.py"
                                value={command}
                                onChange={(e) => setCommand(e.target.value)}
                                className="font-mono text-xs h-20"
                            />
                            <p className="text-[10px] text-muted-foreground">
                                Parameters will be appended as --key=value
                            </p>
                        </div>

                        {/* Parameters */}
                        <div className="space-y-2">
                            <div className="flex items-center justify-between">
                                <Label>Parameters</Label>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 px-2 text-xs"
                                    onClick={addParameter}
                                >
                                    <Plus className="h-3 w-3 mr-1" />
                                    Add
                                </Button>
                            </div>

                            <div className="space-y-2">
                                {parameters.map((param, index) => (
                                    <div key={index} className="flex gap-2 items-start">
                                        <Input
                                            placeholder="key"
                                            value={param.key}
                                            onChange={(e) => updateParameter(index, 'key', e.target.value)}
                                            className="w-24 text-xs"
                                        />
                                        <Input
                                            placeholder="values (comma-separated)"
                                            value={param.values}
                                            onChange={(e) => updateParameter(index, 'values', e.target.value)}
                                            className="flex-1 text-xs"
                                        />
                                        {parameters.length > 1 && (
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-8 w-8 shrink-0"
                                                onClick={() => removeParameter(index)}
                                            >
                                                <Trash2 className="h-3 w-3" />
                                            </Button>
                                        )}
                                    </div>
                                ))}
                            </div>
                            <p className="text-[10px] text-muted-foreground">
                                Example: lr → 0.001, 0.01, 0.1
                            </p>
                        </div>

                        {/* Max Runs */}
                        <div className="space-y-2">
                            <Label htmlFor="max-runs">Max Runs</Label>
                            <Input
                                id="max-runs"
                                type="number"
                                min="1"
                                max="100"
                                value={maxRuns}
                                onChange={(e) => setMaxRuns(e.target.value)}
                                className="w-24"
                            />
                        </div>

                        {/* Expected runs */}
                        <div className="rounded-lg bg-secondary/50 p-3">
                            <p className="text-xs text-muted-foreground">
                                This will create <span className="font-medium text-foreground">{getExpectedRunCount()}</span> runs
                            </p>
                        </div>

                        {/* Error */}
                        {error && (
                            <div className="rounded-lg bg-destructive/10 border border-destructive/30 p-3">
                                <p className="text-xs text-destructive">{error}</p>
                            </div>
                        )}
                    </div>
                </ScrollArea>

                <DialogFooter className="gap-2 sm:gap-2">
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                        disabled={isSubmitting}
                    >
                        Cancel
                    </Button>
                    <Button
                        variant="secondary"
                        onClick={() => handleCreate(false)}
                        disabled={isSubmitting}
                    >
                        Create (Ready)
                    </Button>
                    <Button
                        onClick={() => handleCreate(true)}
                        disabled={isSubmitting}
                    >
                        <Play className="h-4 w-4 mr-1.5" />
                        Create & Start
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
