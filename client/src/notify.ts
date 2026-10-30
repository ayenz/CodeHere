import { $ } from './dom'

const announcer = $('announcer')
const toast = $('toast')
let toastTimer = 0

/** Reads a message to screen readers without showing it. */
export function announce(message: string): void {
  // Clearing first makes repeated identical messages announce again.
  announcer.textContent = ''
  window.setTimeout(() => (announcer.textContent = message), 50)
}

/** Shows a short message on screen and announces it to screen readers. */
export function notify(message: string): void {
  announce(message)
  toast.textContent = message
  toast.classList.add('visible')
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 2200)
}
