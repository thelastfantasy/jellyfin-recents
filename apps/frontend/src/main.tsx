import { render } from 'preact'
import { App } from './components/App'
import { detectLocale } from './i18n'
import './styles.css'

/** Update page title attribute and sidebar link text to match detected locale */
function applyLocaleToPage(title: string): void {
  // Update data-title used by Jellyfin's SPA router for page header
  const page = document.getElementById('jellyfinSuitePage')
  if (page) page.setAttribute('data-title', title)

  // Best-effort: find the sidebar anchor linking to this plugin page and rename it
  document.querySelectorAll<HTMLAnchorElement>('a').forEach((a) => {
    if (a.href?.includes('JellyfinSuite') && !a.href?.includes('Bundle')) {
      // The text may live in a child span or directly as text
      const span = a.querySelector('span:not(.navMenuOptionIcon)')
      if (span) span.textContent = title
      else {
        // Replace only text nodes, leave icon elements untouched
        for (const node of Array.from(a.childNodes)) {
          if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
            node.textContent = title
            break
          }
        }
      }
    }
  })
}

let _mounted = false

async function mount() {
  const root = document.getElementById('jellyfin-suite-root')
  if (!root || !window.ApiClient) return
  // 防止重复挂载
  if (_mounted && root.childElementCount > 0) return

  const locale = await detectLocale()
  const { getTranslations } = await import('./i18n')
  const t = getTranslations(locale)

  applyLocaleToPage(t.appTitle)

  if (_mounted) return // second viewshow after already mounted — skip re-render
  _mounted = true
  render(<App locale={locale} />, root)
}

// 立即尝试（桌面端通常直接成功）
mount()

// Jellyfin SPA 每次显示页面时在页面元素上触发 viewshow
// 手机端 / 二次导航时作为保底
document.getElementById('jellyfinSuitePage')?.addEventListener('viewshow', mount)
