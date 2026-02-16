export type JourneySubTab = 'story' | 'devnotes'

export type HomeTab =
  | 'chat'
  | 'runs'
  | 'charts'
  | 'memory'
  | 'events'
  | 'skills'
  | 'plans'
  | 'journey'
  | 'report'
  | 'explorer'
  | 'terminal'
  | 'settings'

export type AppTab = HomeTab | 'contextual'

export const HOME_TAB_QUERY_KEY = 'tab'
export const JOURNEY_SUB_TAB_QUERY_KEY = 'journeySubTab'

const HOME_TABS: readonly HomeTab[] = [
  'chat',
  'runs',
  'charts',
  'memory',
  'events',
  'skills',
  'plans',
  'journey',
  'report',
  'explorer',
  'terminal',
  'settings',
]

export function isHomeTab(value: string | null | undefined): value is HomeTab {
  return value != null && HOME_TABS.includes(value as HomeTab)
}

export function isJourneySubTab(value: string | null | undefined): value is JourneySubTab {
  return value === 'story' || value === 'devnotes'
}

export function parseHomeTab(searchParams: URLSearchParams, fallback: HomeTab = 'chat'): HomeTab {
  const raw = searchParams.get(HOME_TAB_QUERY_KEY)
  return isHomeTab(raw) ? raw : fallback
}

export function parseJourneySubTab(
  searchParams: URLSearchParams,
  fallback: JourneySubTab = 'story'
): JourneySubTab {
  const raw = searchParams.get(JOURNEY_SUB_TAB_QUERY_KEY)
  return isJourneySubTab(raw) ? raw : fallback
}

export function buildHomeSearchParams(tab: HomeTab, journeySubTab: JourneySubTab = 'story') {
  const params = new URLSearchParams()
  if (tab !== 'chat') {
    params.set(HOME_TAB_QUERY_KEY, tab)
  }
  if (tab === 'journey') {
    params.set(JOURNEY_SUB_TAB_QUERY_KEY, journeySubTab)
  }
  return params
}

export function buildHomeHref(tab: HomeTab, journeySubTab: JourneySubTab = 'story') {
  const params = buildHomeSearchParams(tab, journeySubTab)
  const query = params.toString()
  return query ? `/?${query}` : '/'
}
