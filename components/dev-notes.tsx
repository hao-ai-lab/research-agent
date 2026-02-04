'use client'

import { useState } from 'react'
import { ArrowLeft, Edit2, Save, X, Tag } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'

export interface WishlistItem {
  id: string
  title: string
  description: string
  tags: string[]
}

const initialWishlistItems: WishlistItem[] = [
  {
    id: '1',
    title: 'Git Tree for Chat History',
    description: 'I want the chat and chat history conversations to have git tree to show the research progress.',
    tags: ['visualization', 'chat', 'version-control'],
  },
  {
    id: '2',
    title: 'Chat Modes (Focus, Work, etc.)',
    description: 'I want to show focus mode, work mode and some other modes in the chat box.',
    tags: ['chat', 'modes', 'ui'],
  },
  {
    id: '3',
    title: 'Notebook',
    description: 'I want to have notebook functionality.',
    tags: ['feature', 'notes'],
  },
  {
    id: '4',
    title: 'Slack and WeChat Integration',
    description: 'I want to have slack and wechat integration.',
    tags: ['integration', 'communication'],
  },
  {
    id: '5',
    title: 'Better @ Mention Functionality',
    description: 'I want to make the refer @ functionality better at selecting items and groups.',
    tags: ['chat', 'ui', 'mentions'],
  },
  {
    id: '6',
    title: 'Better Chat Tab/Thread UI',
    description: 'I want to make chat tab / thread ui better.',
    tags: ['chat', 'ui', 'threads'],
  },
  {
    id: '7',
    title: 'Nanoclaw Integration',
    description: 'I want to integrate with nanoclaw.',
    tags: ['integration', 'tools'],
  },
  {
    id: '8',
    title: 'Browser Cursor Backend Integration',
    description: 'I want to integrate backend with browser cursor.',
    tags: ['integration', 'backend', 'cursor'],
  },
  {
    id: '9',
    title: 'Repo Version Control & Visualization',
    description: 'I want it to be able to add version control / git tree of the repo, and visualize how it associate it with experiments.',
    tags: ['version-control', 'visualization', 'experiments'],
  },
  {
    id: '10',
    title: 'Notification System',
    description: 'I want to have notification.',
    tags: ['feature', 'alerts'],
  },
]

interface DevNotesProps {
  onBack: () => void
}

export function DevNotes({ onBack }: DevNotesProps) {
  const [wishlistItems, setWishlistItems] = useState<WishlistItem[]>(initialWishlistItems)
  const [selectedItem, setSelectedItem] = useState<WishlistItem | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [editedDescription, setEditedDescription] = useState('')

  const handleItemClick = (item: WishlistItem) => {
    setSelectedItem(item)
    setEditedDescription(item.description)
    setIsEditing(false)
  }

  const handleSave = () => {
    if (selectedItem) {
      setWishlistItems((items) =>
        items.map((item) =>
          item.id === selectedItem.id ? { ...item, description: editedDescription } : item
        )
      )
      setSelectedItem({ ...selectedItem, description: editedDescription })
      setIsEditing(false)
    }
  }

  const handleCancel = () => {
    if (selectedItem) {
      setEditedDescription(selectedItem.description)
    }
    setIsEditing(false)
  }

  // Get unique tags for filtering
  const allTags = Array.from(new Set(wishlistItems.flatMap((item) => item.tags)))

  if (selectedItem) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-background">
        <div className="shrink-0 flex items-center gap-3 border-b border-border px-4 py-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setSelectedItem(null)}
            className="h-8 w-8"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex-1 min-w-0">
            <h2 className="font-semibold text-foreground truncate text-sm">{selectedItem.title}</h2>
          </div>
          {!isEditing && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setIsEditing(true)}
              className="h-8 w-8"
            >
              <Edit2 className="h-4 w-4" />
            </Button>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="p-4 space-y-4">
              {/* Tags */}
              <div className="flex flex-wrap gap-1.5">
                {selectedItem.tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="text-[10px]">
                    {tag}
                  </Badge>
                ))}
              </div>

              {/* Description */}
              <div className="space-y-2">
                <h3 className="font-medium text-sm text-foreground">Description</h3>
                {isEditing ? (
                  <div className="space-y-3">
                    <Textarea
                      value={editedDescription}
                      onChange={(e) => setEditedDescription(e.target.value)}
                      className="min-h-[120px] text-sm"
                      placeholder="Enter description..."
                    />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={handleSave}
                        className="flex-1"
                      >
                        <Save className="h-3.5 w-3.5 mr-1.5" />
                        Save
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleCancel}
                        className="flex-1"
                      >
                        <X className="h-3.5 w-3.5 mr-1.5" />
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-lg bg-secondary/50 border border-border p-3">
                    <p className="text-sm text-foreground/90 whitespace-pre-wrap leading-relaxed">
                      {selectedItem.description}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </ScrollArea>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="shrink-0 flex items-center gap-3 border-b border-border px-4 py-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          className="h-8 w-8"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <h2 className="font-semibold text-foreground text-sm">Dev Notes</h2>
          <p className="text-xs text-muted-foreground">Wishlist for future features</p>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="p-4 space-y-3">
            {/* Intro */}
            <div className="rounded-lg bg-gradient-to-br from-blue-500/20 to-purple-500/20 border border-blue-500/30 p-4 mb-4">
              <div className="flex items-start gap-3">
                <div className="rounded-full bg-blue-500/20 p-2">
                  <Tag className="h-5 w-5 text-blue-400" />
                </div>
                <div>
                  <h3 className="font-semibold text-foreground">Feature Wishlist</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Ideas and features we want to implement in the future. Click on any item to view details and edit.
                  </p>
                </div>
              </div>
            </div>

            {/* Wishlist Items */}
            {wishlistItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => handleItemClick(item)}
                className="w-full text-left rounded-lg border border-border bg-card p-3 transition-colors hover:bg-secondary/50 hover:border-accent/30"
              >
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <h4 className="font-medium text-sm text-foreground">{item.title}</h4>
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                      {item.description}
                    </p>
                    <div className="flex flex-wrap gap-1 mt-2">
                      {item.tags.map((tag) => (
                        <Badge key={tag} variant="outline" className="text-[9px] px-1.5 py-0">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
