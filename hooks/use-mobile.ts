import * as React from 'react'

const MOBILE_BREAKPOINT = 768
export const MOBILE_WIDTH = 300
export const MOBILE_HEIGHT = 644

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener('change', onChange)
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return !!isMobile
}

export interface WindowSize {
  width: number
  height: number
}

export function useWindowSize(): WindowSize {
  const [windowSize, setWindowSize] = React.useState<WindowSize>({
    width: typeof window !== 'undefined' ? window.innerWidth : MOBILE_WIDTH,
    height: typeof window !== 'undefined' ? window.innerHeight : MOBILE_HEIGHT,
  })

  React.useEffect(() => {
    const handleResize = () => {
      setWindowSize({
        width: window.innerWidth,
        height: window.innerHeight,
      })
    }

    // Set initial size
    handleResize()

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  return windowSize
}

/**
 * Returns the appropriate min dimensions for the mobile viewport
 * Uses the actual window size when smaller than the default mobile dimensions
 */
export function useMobileViewportSize(): { minWidth: number; minHeight: number } {
  const { width, height } = useWindowSize()
  
  return {
    minWidth: Math.min(width, MOBILE_WIDTH),
    minHeight: Math.min(height, MOBILE_HEIGHT),
  }
}
