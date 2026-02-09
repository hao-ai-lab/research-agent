'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'

export default function AssistantPage() {
  const router = useRouter()

  useEffect(() => {
    router.replace('/contextual')
  }, [router])

  return (
    <div className="flex h-dvh w-screen items-center justify-center bg-background">
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Redirecting to contextual chat...
      </div>
    </div>
  )
}
