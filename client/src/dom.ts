export function $<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing #${id}`)
  return element as T
}

export function readSetting(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeSetting(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Storage can be unavailable (private mode); the setting then lasts for this page view.
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    window.prompt('Copy this link', text)
    return false
  }
}

/**
 * Positions a `popover` element under its trigger button. Popovers render in the top layer,
 * so they are placed with fixed coordinates and kept inside the viewport.
 */
export function anchorPopover(popover: HTMLElement, trigger: HTMLElement, align: 'start' | 'end' = 'end'): void {
  popover.addEventListener('toggle', (event) => {
    const open = (event as ToggleEvent).newState === 'open'
    trigger.setAttribute('aria-expanded', String(open))
    if (!open) return
    const rect = trigger.getBoundingClientRect()
    const width = popover.offsetWidth
    const height = popover.offsetHeight
    const margin = 8
    let left = align === 'end' ? rect.right - width : rect.left
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin))
    // Open upwards when there is no room below (e.g. triggers in the status bar).
    const below = rect.bottom + 6
    const top = below + height > window.innerHeight - margin ? rect.top - height - 6 : below
    popover.style.left = `${left}px`
    popover.style.top = `${Math.max(margin, top)}px`
  })
}
