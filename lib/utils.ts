import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

const ACTION_TAG_RE = /<(?:spawn_research|spawn_command|steer_child|stop_child)>[\s\S]*?<\/(?:spawn_research|spawn_command|steer_child|stop_child)>/g

/**
 * Strip L1 action XML blocks from text so the user sees clean content.
 * Handles partial (still-streaming) tags by also removing unclosed opening tags.
 */
export function stripActionTags(text: string): string {
  // Remove complete tags
  let cleaned = text.replace(ACTION_TAG_RE, '')
  // Remove partial/unclosed opening tags that are still streaming in
  cleaned = cleaned.replace(/<(?:spawn_research|spawn_command|steer_child|stop_child)>[\s\S]*$/g, '')
  // Also catch a bare opening tag with no content yet
  cleaned = cleaned.replace(/<(?:spawn_research|spawn_command|steer_child|stop_child)\s*$/g, '')
  // Collapse runs of 3+ newlines
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n')
  return cleaned.trimEnd()
}
