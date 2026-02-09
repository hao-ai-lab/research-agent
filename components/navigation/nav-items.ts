import {
  BarChart3,
  Bell,
  FileText,
  FlaskConical,
  Lightbulb,
  MessageSquare,
  Orbit,
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
    tab: 'report',
    label: 'Report',
    icon: FileText,
  },
  {
    tab: 'contextual',
    label: 'Contextual',
    icon: Orbit,
  },
]
