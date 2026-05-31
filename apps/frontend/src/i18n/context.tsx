import { createContext } from 'preact'
import { useContext } from 'preact/hooks'
import type { Locale, Translations } from './index'
import { getTranslations } from './index'

export interface LocaleContextValue {
  locale: Locale
  t: Translations
}

export const LocaleContext = createContext<LocaleContextValue>({
  locale: 'zh',
  t: getTranslations('zh'),
})

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext)
}
