'use client'

import { ArrowLeft } from 'lucide-react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { SettingsPageContent } from '@/components/settings-page-content'
import { useAppSettings } from '@/lib/app-settings'

export default function SettingsPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { settings, setSettings } = useAppSettings()

  const focusAuthToken = searchParams.get('focusAuthToken') === '1'

  return (
    <div className="h-dvh w-screen overflow-hidden bg-background">
      <main className="mobile-viewport-wrapper flex h-full w-full flex-col overflow-hidden bg-background">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => router.push('/')}
            className="h-9 w-9"
            aria-label="Back"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-sm font-medium">Settings</h1>
        </header>

        <div className="min-h-0 flex-1 overflow-hidden">
          <SettingsPageContent
            settings={settings}
            onSettingsChange={setSettings}
            focusAuthToken={focusAuthToken}
            onNavigateToJourney={(subTab) => {
              router.push(`/?tab=journey&journeySubTab=${subTab}`)
            }}
          />
        </div>
      </main>
    </div>
  )
}
