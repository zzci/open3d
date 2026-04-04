import { useCallback, useEffect, useMemo, useState } from 'react'
import { ThemeContext } from './theme-context'

type Theme = 'dark' | 'light' | 'system'

const STORAGE_KEY = 'open3d-theme'

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window === 'undefined')
      return 'system'
    return (localStorage.getItem(STORAGE_KEY) as Theme) ?? 'system'
  })

  const setTheme = useCallback((t: Theme) => {
    localStorage.setItem(STORAGE_KEY, t)
    setThemeState(t)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    root.classList.remove('light', 'dark')

    if (theme === 'system') {
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      root.classList.add(systemTheme)
    }
    else {
      root.classList.add(theme)
    }
  }, [theme])

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme])

  return <ThemeContext value={value}>{children}</ThemeContext>
}
