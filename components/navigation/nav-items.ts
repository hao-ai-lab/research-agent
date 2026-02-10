import {
  BarChart3,
  Bell,
  FileText,
  FolderTree,
  FlaskConical,
  Lightbulb,
  MessageSquare,
  Orbit,
  Wand2,
  type LucideIcon,
} from 'lucide-react'
import type { HomeTab } from '@/lib/navigation'

export type PrimaryNavTarget = Exclude<HomeTab, 'settings' | 'journey'> | 'contextual'

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
    tab: 'charts',
    label: 'Charts',
    icon: BarChart3,
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
    tab: 'contextual',
    label: 'Contextual',
    icon: Orbit,
  },
]
