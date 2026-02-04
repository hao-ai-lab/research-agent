'use client'

import { useState } from 'react'
import { Plus, Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { TagDefinition } from '@/lib/types'
import { DEFAULT_TAG_COLORS } from '@/lib/mock-data'

interface TagsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  existingTags?: TagDefinition[]
  allTags?: TagDefinition[]
  selectedTags?: string[]
  onToggleTag: (tagName: string) => void
  onCreateTag?: (tag: TagDefinition) => void
}

export function TagsDialog({
  open,
  onOpenChange,
  existingTags,
  allTags,
  selectedTags = [],
  onToggleTag,
  onCreateTag,
}: TagsDialogProps) {
  const tags = existingTags || allTags || []
  const [newTagName, setNewTagName] = useState('')
  const [newTagColor, setNewTagColor] = useState(DEFAULT_TAG_COLORS[0])
  const [isCreating, setIsCreating] = useState(false)

  const handleCreate = () => {
    if (newTagName.trim() && !tags.find(t => t.name === newTagName.trim())) {
      onCreateTag?.({ name: newTagName.trim(), color: newTagColor })
      setNewTagName('')
      setNewTagColor(DEFAULT_TAG_COLORS[0])
      setIsCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Manage Tags</DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4">
          {/* Existing Tags */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Available Tags
            </p>
            <div className="flex flex-wrap gap-2">
              {tags.map((tag) => {
                const isSelected = selectedTags.includes(tag.name)
                return (
                  <button
                    key={tag.name}
                    type="button"
                    onClick={() => onToggleTag(tag.name)}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-all ${
                      isSelected
                        ? 'ring-2 ring-offset-2 ring-offset-background'
                        : 'opacity-70 hover:opacity-100'
                    }`}
                    style={{ 
                      backgroundColor: `${tag.color}20`,
                      color: tag.color,
                      borderColor: tag.color,
                      ...(isSelected && { ringColor: tag.color })
                    }}
                  >
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: tag.color }}
                    />
                    {tag.name}
                    {isSelected && <Check className="h-3 w-3" />}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Create New Tag */}
          {isCreating ? (
            <div className="space-y-3 p-3 rounded-lg border border-border bg-secondary/50">
              <div className="flex items-center gap-2">
                <Input
                  placeholder="Tag name..."
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                  className="h-8 text-sm flex-1"
                  autoFocus
                />
                <Button
                  size="sm"
                  onClick={handleCreate}
                  disabled={!newTagName.trim()}
                  className="h-8 px-3"
                >
                  Add
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setIsCreating(false)
                    setNewTagName('')
                  }}
                  className="h-8 w-8 p-0"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-2">Color</p>
                <div className="flex gap-2">
                  {DEFAULT_TAG_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => setNewTagColor(color)}
                      className={`h-6 w-6 rounded-full border-2 transition-transform hover:scale-110 ${
                        newTagColor === color ? 'border-foreground scale-110' : 'border-transparent'
                      }`}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsCreating(true)}
              className="w-full bg-transparent"
            >
              <Plus className="h-4 w-4 mr-1.5" />
              Create New Tag
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
