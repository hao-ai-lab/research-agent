'use client'

import { useState } from 'react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, Eye, EyeOff } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import type { AppSettings, LeftPanelItemConfig } from '@/lib/types'

interface LeftPanelConfigProps {
  settings: AppSettings
  onSettingsChange: (settings: AppSettings) => void
}

interface SortableItemProps {
  item: LeftPanelItemConfig
  onToggleVisibility: (id: string) => void
}

function SortableItem({ item, onToggleVisibility }: SortableItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-3 rounded-lg bg-secondary/50 p-3"
    >
      <button
        type="button"
        className="cursor-grab touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <div className="flex-1">
        <p className="text-sm font-medium text-foreground">{item.label}</p>
      </div>
      <div className="flex items-center gap-2">
        {item.visible ? (
          <Eye className="h-4 w-4 text-muted-foreground" />
        ) : (
          <EyeOff className="h-4 w-4 text-muted-foreground" />
        )}
        <Switch
          checked={item.visible}
          onCheckedChange={() => onToggleVisibility(item.id)}
        />
      </div>
    </div>
  )
}

export function LeftPanelConfig({ settings, onSettingsChange }: LeftPanelConfigProps) {
  const items = settings.leftPanel?.items || []
  const [localItems, setLocalItems] = useState<LeftPanelItemConfig[]>(items)

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event

    if (over && active.id !== over.id) {
      const oldIndex = localItems.findIndex((item) => item.id === active.id)
      const newIndex = localItems.findIndex((item) => item.id === over.id)

      const reorderedItems = arrayMove(localItems, oldIndex, newIndex).map(
        (item, index) => ({ ...item, order: index })
      )

      setLocalItems(reorderedItems)
      onSettingsChange({
        ...settings,
        leftPanel: { items: reorderedItems },
      })
    }
  }

  const handleToggleVisibility = (id: string) => {
    const updatedItems = localItems.map((item) =>
      item.id === id ? { ...item, visible: !item.visible } : item
    )

    setLocalItems(updatedItems)
    onSettingsChange({
      ...settings,
      leftPanel: { items: updatedItems },
    })
  }

  // Sync localItems with settings when they change externally
  if (JSON.stringify(items) !== JSON.stringify(localItems)) {
    setLocalItems(items)
  }

  return (
    <div className="rounded-lg bg-secondary/50 p-4">
      <div className="mb-3">
        <p className="text-sm font-medium text-foreground">Left Panel Items</p>
        <p className="text-xs text-muted-foreground">
          Drag to reorder, toggle to show/hide
        </p>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={localItems.map((item) => item.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-2">
            {localItems.map((item) => (
              <SortableItem
                key={item.id}
                item={item}
                onToggleVisibility={handleToggleVisibility}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      <p className="mt-3 text-xs text-muted-foreground">
        Note: Journey and Settings items are not affected by this configuration.
      </p>
    </div>
  )
}
