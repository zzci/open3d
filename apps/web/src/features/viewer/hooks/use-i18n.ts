import { useCallback, useSyncExternalStore } from 'react'
import { getLang, onLangChange, setLang, t } from '../i18n'
import type { Lang, TextKey } from '../i18n'

export function useI18n() {
  const lang = useSyncExternalStore(onLangChange, getLang)
  const toggle = useCallback(() => {
    setLang(lang === 'en' ? 'zh' : 'en')
  }, [lang])

  return {
    lang,
    t: t as (key: TextKey) => string,
    toggle,
    setLang: setLang as (lang: Lang) => void,
  }
}
