/**
 * Extracts unique @type:id reference tokens from message text.
 * Scans for patterns like @run:abc123, @sweep:xyz, @artifact:foo, etc.
 */

const REFERENCE_REGEX = /@((?:run|sweep|artifact|alert|chart|chat|skill):[A-Za-z0-9:._-]+)/g

export interface ContextReference {
  /** Full reference string, e.g. "run:abc123" */
  reference: string
  /** The type portion, e.g. "run" */
  type: string
  /** The id portion, e.g. "abc123" */
  id: string
}

/**
 * Extract all unique reference tokens from one or more text strings.
 * Returns deduplicated references in the order they first appear.
 */
export function extractContextReferences(...texts: (string | undefined | null)[]): ContextReference[] {
  const seen = new Set<string>()
  const results: ContextReference[] = []

  for (const text of texts) {
    if (!text) continue

    let match: RegExpExecArray | null
    // Reset lastIndex since we reuse the regex
    const regex = new RegExp(REFERENCE_REGEX.source, 'g')
    while ((match = regex.exec(text)) !== null) {
      const reference = match[1]
      if (!seen.has(reference)) {
        seen.add(reference)
        const [type, ...idParts] = reference.split(':')
        results.push({
          reference,
          type,
          id: idParts.join(':'),
        })
      }
    }
  }

  return results
}
