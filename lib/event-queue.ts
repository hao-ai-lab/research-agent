/**
 * EventQueue — Priority queue for wild loop events.
 *
 * Sorted by (priority ASC, createdAt ASC).  Lower priority number = higher urgency.
 * Supports drag-reorder (manual override), dedup by id, and positional insert.
 */

export interface QueuedEvent {
  id: string
  priority: number          // 10=user, 20=critical alert, 30=warning, 50=run event, 70=analysis, 90=exploring
  title: string             // Short label for UI display
  prompt: string            // Full prompt text sent to agent
  type: 'steer' | 'alert' | 'run_event' | 'analysis' | 'exploring'
  createdAt: number         // Date.now()
}

export const PRIORITY_LABELS: Record<number, { label: string; color: string }> = {
  10: { label: 'User', color: '#ef4444' },       // red
  20: { label: 'Critical', color: '#f97316' },    // orange
  30: { label: 'Warning', color: '#eab308' },     // yellow
  50: { label: 'Run Event', color: '#3b82f6' },   // blue
  70: { label: 'Analysis', color: '#8b5cf6' },    // violet
  90: { label: 'Exploring', color: '#6b7280' },   // gray
}

export class EventQueue {
  private _items: QueuedEvent[] = []
  private _idSet = new Set<string>()

  /** Number of items in the queue */
  get size(): number {
    return this._items.length
  }

  /** Readonly snapshot of current items (in priority order) */
  get items(): readonly QueuedEvent[] {
    return this._items
  }

  /**
   * Add an event. Deduplicates by id — if an event with the same id
   * already exists, it is silently ignored.
   */
  enqueue(event: QueuedEvent): boolean {
    if (this._idSet.has(event.id)) return false
    this._idSet.add(event.id)

    // Binary insert to maintain sorted order
    const idx = this._findInsertIndex(event)
    this._items.splice(idx, 0, event)
    return true
  }

  /** Remove and return the highest-priority (lowest number) event. */
  dequeue(): QueuedEvent | null {
    if (this._items.length === 0) return null
    const event = this._items.shift()!
    this._idSet.delete(event.id)
    return event
  }

  /** Peek at the next event without removing it. */
  peek(): QueuedEvent | null {
    return this._items[0] ?? null
  }

  /** Remove a specific event by id. */
  remove(id: string): boolean {
    if (!this._idSet.has(id)) return false
    this._idSet.delete(id)
    this._items = this._items.filter(e => e.id !== id)
    return true
  }

  /**
   * Manual reorder — sets the order to match the given id list.
   * This overrides priority-based sorting (user drag reorder).
   * Any ids not in the list are appended at the end in their current order.
   */
  reorder(orderedIds: string[]): void {
    const idToItem = new Map(this._items.map(e => [e.id, e]))
    const reordered: QueuedEvent[] = []
    const seen = new Set<string>()

    for (const id of orderedIds) {
      const item = idToItem.get(id)
      if (item && !seen.has(id)) {
        reordered.push(item)
        seen.add(id)
      }
    }

    // Append any remaining items not in the ordered list
    for (const item of this._items) {
      if (!seen.has(item.id)) {
        reordered.push(item)
      }
    }

    this._items = reordered
  }

  /**
   * Insert an event at a specific index (for manual placement).
   * Deduplicates by id.
   */
  insertAt(event: QueuedEvent, index: number): boolean {
    if (this._idSet.has(event.id)) return false
    this._idSet.add(event.id)
    const clampedIndex = Math.max(0, Math.min(index, this._items.length))
    this._items.splice(clampedIndex, 0, event)
    return true
  }

  /** Clear all events. */
  clear(): void {
    this._items = []
    this._idSet.clear()
  }

  // ---- internals ----

  /** Find the insertion index to maintain (priority ASC, createdAt ASC) order. */
  private _findInsertIndex(event: QueuedEvent): number {
    let lo = 0
    let hi = this._items.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      const existing = this._items[mid]
      if (
        existing.priority < event.priority ||
        (existing.priority === event.priority && existing.createdAt <= event.createdAt)
      ) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }
    return lo
  }
}
