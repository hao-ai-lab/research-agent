'use client'

import { TypelessView } from '@/components/typeless-view'

export default function TypelessPage() {
  return (
    <div className="w-screen h-dvh overflow-hidden bg-background flex items-center justify-center">
      {/* Phone frame wrapper */}
      <div className="relative w-full h-full max-w-[430px] max-h-[932px] md:rounded-[2.5rem] md:border-[6px] md:border-foreground/10 md:shadow-2xl md:shadow-black/20 overflow-hidden bg-background">
        {/* Notch / Dynamic Island (desktop only) */}
        <div className="hidden md:flex absolute top-2 left-1/2 -translate-x-1/2 z-50 w-[126px] h-[34px] bg-black rounded-full items-center justify-center">
          <div className="w-3 h-3 rounded-full bg-foreground/5 border border-foreground/10" />
        </div>

        {/* Home indicator (desktop only) */}
        <div className="hidden md:block absolute bottom-2 left-1/2 -translate-x-1/2 z-50 w-[134px] h-[5px] bg-foreground/20 rounded-full" />

        {/* App content */}
        <TypelessView />
      </div>
    </div>
  )
}
