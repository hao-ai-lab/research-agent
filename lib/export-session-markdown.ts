import type { ChatMessage } from '@/lib/types'

/**
 * Convert a list of chat messages into a shareable Markdown string.
 */
export function exportSessionToMarkdown(
  messages: ChatMessage[],
  sessionTitle?: string
): string {
  const title = sessionTitle?.trim() || 'Untitled Session'
  const exportDate = new Date().toLocaleString()

  const lines: string[] = [
    `# ${title}`,
    '',
    `> Exported on ${exportDate}`,
    '',
    '---',
    '',
  ]

  for (const message of messages) {
    const roleLabel = message.role === 'user' ? '🧑 **You**' : '🤖 **Assistant**'
    const time = message.timestamp.toLocaleString()

    lines.push(`## ${roleLabel}`)
    lines.push(`*${time}*`)
    lines.push('')

    // Render parts if available (structured messages)
    if (message.parts && message.parts.length > 0) {
      for (const part of message.parts) {
        if (part.type === 'thinking' && part.content) {
          lines.push('<details>')
          lines.push('<summary>💭 Thinking</summary>')
          lines.push('')
          lines.push(part.content)
          lines.push('')
          lines.push('</details>')
          lines.push('')
        } else if (part.type === 'tool') {
          const toolLabel = part.toolName || 'Tool'
          const status = part.toolState || 'unknown'
          lines.push('<details>')
          lines.push(`<summary>🔧 ${toolLabel} (${status})</summary>`)
          lines.push('')
          if (part.toolInput) {
            lines.push('**Input:**')
            lines.push('```')
            lines.push(part.toolInput)
            lines.push('```')
            lines.push('')
          }
          if (part.toolOutput) {
            lines.push('**Output:**')
            lines.push('```')
            lines.push(part.toolOutput)
            lines.push('```')
            lines.push('')
          }
          lines.push('</details>')
          lines.push('')
        } else if (part.type === 'text' && part.content) {
          lines.push(part.content)
          lines.push('')
        }
      }
    } else {
      // Legacy: render thinking + content directly
      if (message.thinking) {
        lines.push('<details>')
        lines.push('<summary>💭 Thinking</summary>')
        lines.push('')
        lines.push(message.thinking)
        lines.push('')
        lines.push('</details>')
        lines.push('')
      }

      if (message.content) {
        lines.push(message.content)
        lines.push('')
      }
    }

    lines.push('---')
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * Trigger a browser download of the given text content as a .md file.
 */
export function downloadMarkdown(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
