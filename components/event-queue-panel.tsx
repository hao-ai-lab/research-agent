"use client";

import { useState, useCallback } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, ChevronRight, GripVertical, X, Plus } from "lucide-react";
import type { QueuedEvent } from "@/lib/event-queue";
import { PRIORITY_LABELS } from "@/lib/event-queue";

// ─── Priority badge ───

function PriorityBadge({ priority }: { priority: number }) {
  const info = PRIORITY_LABELS[priority] || {
    label: `P${priority}`,
    color: "#6b7280",
  };
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none"
      style={{
        backgroundColor: `${info.color}20`,
        color: info.color,
        border: `1px solid ${info.color}40`,
      }}
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: info.color }}
      />
      {info.label}
    </span>
  );
}

// ─── Type label ───

const TYPE_ICONS: Record<string, string> = {
  steer: "🧭",
  alert: "🔔",
  run_event: "🏃",
  analysis: "📊",
  exploring: "🔍",
};

// ─── Sortable queue item ───

interface SortableQueueItemProps {
  event: QueuedEvent;
  onRemove: (id: string) => void;
}

function SortableQueueItem({ event, onRemove }: SortableQueueItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: event.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 rounded-md bg-secondary/40 px-2 py-1.5 text-sm"
    >
      <button
        type="button"
        className="cursor-grab touch-none text-muted-foreground/60 hover:text-muted-foreground active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>

      <PriorityBadge priority={event.priority} />

      <span className="mr-0.5 text-xs">{TYPE_ICONS[event.type] || "❓"}</span>

      <span className="flex-1 truncate text-xs text-foreground/80">
        {event.title}
      </span>

      <button
        type="button"
        onClick={() => onRemove(event.id)}
        className="rounded p-0.5 text-muted-foreground/50 hover:bg-destructive/10 hover:text-destructive"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

// ─── Inline insert form ───

interface InsertFormProps {
  onInsert: (event: QueuedEvent) => void;
  onCancel: () => void;
}

function InsertForm({ onInsert, onCancel }: InsertFormProps) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [priority, setPriority] = useState(10);

  const handleSubmit = () => {
    if (!title.trim() || !prompt.trim()) return;
    onInsert({
      id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      priority,
      title: title.trim(),
      prompt: prompt.trim(),
      type: "steer",
      createdAt: Date.now(),
    });
  };

  return (
    <div className="space-y-2 rounded-md border border-border/50 bg-secondary/30 p-2">
      <input
        className="w-full rounded-md border border-border/40 bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/40"
        placeholder="Title (e.g. Check training loss)"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        autoFocus
      />
      <textarea
        className="w-full resize-none rounded-md border border-border/40 bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/40"
        placeholder="Prompt text to send to the agent..."
        rows={3}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <div className="flex items-center gap-2">
        <select
          className="rounded-md border border-border/40 bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40"
          value={priority}
          onChange={(e) => setPriority(Number(e.target.value))}
        >
          <option value={10}>P10 — User (highest)</option>
          <option value={20}>P20 — Critical</option>
          <option value={30}>P30 — Warning</option>
          <option value={50}>P50 — Run Event</option>
          <option value={70}>P70 — Analysis</option>
          <option value={90}>P90 — Exploring (lowest)</option>
        </select>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-secondary"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!title.trim() || !prompt.trim()}
          className="rounded-md bg-primary/90 px-2 py-1 text-xs text-primary-foreground hover:bg-primary disabled:opacity-40"
        >
          Add
        </button>
      </div>
    </div>
  );
}

// ─── Main panel ───

export interface EventQueuePanelProps {
  events: QueuedEvent[];
  onReorder: (orderedIds: string[]) => void;
  onRemove: (id: string) => void;
  onInsert: (event: QueuedEvent, index?: number) => void;
}

const MAX_VISIBLE_ITEMS = 5;

export function EventQueuePanel({
  events,
  onReorder,
  onRemove,
  onInsert,
}: EventQueuePanelProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [showInsertForm, setShowInsertForm] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = events.findIndex((e) => e.id === active.id);
      const newIndex = events.findIndex((e) => e.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      const reordered = arrayMove(events, oldIndex, newIndex);
      onReorder(reordered.map((e) => e.id));
    },
    [events, onReorder],
  );

  const handleInsert = useCallback(
    (event: QueuedEvent) => {
      onInsert(event);
      setShowInsertForm(false);
    },
    [onInsert],
  );

  if (events.length === 0 && !showInsertForm) return null;

  const visibleEvents = showAll ? events : events.slice(0, MAX_VISIBLE_ITEMS);
  const hiddenCount = events.length - MAX_VISIBLE_ITEMS;

  return (
    <div className="relative mx-auto w-full max-w-3xl">
      <div className="absolute bottom-0 left-0 right-0 z-30">
        <div className="overflow-hidden rounded-t-lg border border-b-0 border-border/40 bg-secondary/95 shadow-lg backdrop-blur-sm">
          {/* Header */}
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-secondary/30"
          >
            {isExpanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            <span>{events.length} queued</span>
            {!isExpanded && events.length > 0 && (
              <span className="truncate text-muted-foreground/60">
                — next: {events[0].title}
              </span>
            )}
            <div className="flex-1" />
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setShowInsertForm(!showInsertForm);
                if (!isExpanded) setIsExpanded(true);
              }}
              className="rounded p-0.5 text-muted-foreground/60 hover:bg-secondary hover:text-foreground"
              title="Add event to queue"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </button>

          {/* Expanded content */}
          {isExpanded && (
            <div className="max-h-[60vh] overflow-y-auto space-y-1 px-3 pb-2">
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={visibleEvents.map((e) => e.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {visibleEvents.map((event) => (
                    <SortableQueueItem
                      key={event.id}
                      event={event}
                      onRemove={onRemove}
                    />
                  ))}
                </SortableContext>
              </DndContext>

              {/* Show more / less toggle */}
              {hiddenCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowAll(!showAll)}
                  className="w-full rounded-md py-1 text-center text-[11px] font-medium text-muted-foreground/70 hover:bg-secondary/50 hover:text-muted-foreground transition-colors"
                >
                  {showAll ? "Show less" : `+${hiddenCount} more…`}
                </button>
              )}

              {showInsertForm && (
                <InsertForm
                  onInsert={handleInsert}
                  onCancel={() => setShowInsertForm(false)}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
