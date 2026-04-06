import { createContext } from 'react'

export interface ThemeContextValue {
  theme: 'dark' | 'light' | 'system'
  setTheme: (theme: 'dark' | 'light' | 'system') => void
}

export const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)
