// Applies the saved theme before first paint to avoid a flash. Loaded as a plain, blocking
// script from <head> (not inline) so the Content-Security-Policy can forbid inline scripts.
try {
  const saved = localStorage.getItem('codehere:theme')
  document.documentElement.dataset.theme =
    saved === 'light' || saved === 'dark' ? saved : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
} catch {}
