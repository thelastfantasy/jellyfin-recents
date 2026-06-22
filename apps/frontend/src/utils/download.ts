// Fetches the resource into a blob first instead of pointing the anchor straight at `url` —
// a plain `<a download>` lets the browser/server (Content-Disposition, MIME sniffing, SPA link
// interception) decide the outcome, which in practice can silently fall back to navigating/
// opening the resource instead of saving it, or to a server-side default filename. Forcing a
// blob: URL guarantees a save-to-disk with exactly the filename we pass.
export async function downloadBlob(url: string, filename: string): Promise<void> {
  const res = await fetch(url)
  const blob = await res.blob()
  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(objectUrl)
}
