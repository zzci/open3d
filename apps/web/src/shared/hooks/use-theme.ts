import { use } from 'react'
import { ThemeContext } from '@/shared/components/theme-context'

export function useTheme() {
  const ctx = use(ThemeContext)
  if (!ctx)
    throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
