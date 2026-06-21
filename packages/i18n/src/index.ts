export type Lang = 'en' | 'zh' | 'ja'

export function detectLang(): Lang {
  const lang = document.documentElement.lang || navigator.language || 'en'
  const prefix = lang.toLowerCase().split('-')[0]
  if (prefix === 'zh') return 'zh'
  if (prefix === 'ja') return 'ja'
  return 'en'
}

export function createT<T extends Record<string, Record<string, string>>>(
  translations: T,
  lang: string,
): (key: keyof T[keyof T] & string) => string {
  const t = (translations[lang] ?? translations.en ?? {}) as Record<string, string>
  const fallback = (translations.en ?? {}) as Record<string, string>
  return (key: keyof T[keyof T] & string) => t[key] ?? fallback[key] ?? key
}
