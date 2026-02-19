import {
  BarChart3,
  Bell,
  ClipboardList,
  FileText,
  FolderTree,
  FlaskConical,
  GitBranch,
  Lightbulb,
  MessageSquare,
  Orbit,
  Wand2,
  Terminal,
  type LucideIcon,
} from 'lucide-react'
import type { HomeTab } from '@/lib/navigation'

export type PrimaryNavTarget = Exclude<HomeTab, 'settings'> | 'contextual'

export interface PrimaryNavItem {
  tab: PrimaryNavTarget
  label: string
  icon: LucideIcon
}

export const PRIMARY_NAV_ITEMS: PrimaryNavItem[] = [
  {
    tab: 'chat',
    label: 'Chat',
    icon: MessageSquare,
  },
  {
    tab: 'runs',
    label: 'Runs',
    icon: FlaskConical,
  },
  {
    tab: 'events',
    label: 'Events',
    icon: Bell,
  },
  {
    tab: 'plans',
    label: 'Plans',
    icon: ClipboardList,
  },
  {
    tab: 'charts',
    label: 'Charts',
    icon: BarChart3,
  },
  {
    tab: 'journey',
    label: 'User Journey',
    icon: GitBranch,
  },
  {
    tab: 'memory',
    label: 'Memory',
    icon: Lightbulb,
  },
  {
    tab: 'skills',
    label: 'Skills',
    icon: Wand2,
  },
  {
    tab: 'report',
    label: 'Report',
    icon: FileText,
  },
  {
    tab: 'explorer',
    label: 'Explorer',
    icon: FolderTree,
  },
  {
    tab: 'terminal',
    label: 'Terminal',
    icon: Terminal,
  },
  {
    tab: 'contextual',
    label: 'Contextual',
    icon: Orbit,
  },
]
