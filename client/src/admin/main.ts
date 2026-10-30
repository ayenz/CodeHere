import * as api from './api'
import { ApiError, isAbort, type RoomSummary, type Stats } from './api'
import { formatBytes, formatDate, formatDateTime, formatDuration, formatNumber, formatRelative, toIso } from './format'

const PAGE_SIZE = 25

function $<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing #${id}`)
  return element as T
}

/** Builds an element; string children become text nodes, so data is never parsed as HTML. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value)
  element.append(...children)
  return element
}

function timeElement(ms: number, text: string): HTMLElement {
  const iso = toIso(ms)
  return iso ? h('time', { datetime: iso, title: formatDateTime(ms) }, text) : h('span', {}, text)
}

// --- Announcements & toast ------------------------------------------------------

const announcer = $('announcer')
const toastElement = $('toast')
let toastTimer = 0

/** Shows a short message on screen and announces it to screen readers. */
function notify(message: string): void {
  // Clearing first makes repeated identical messages announce again.
  announcer.textContent = ''
  window.setTimeout(() => (announcer.textContent = message), 50)
  toastElement.textContent = message
  toastElement.classList.add('visible')
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => toastElement.classList.remove('visible'), 2400)
}

// --- Theme -----------------------------------------------------------------------

const THEME_KEY = 'codehere:theme'
const themeButton = $<HTMLButtonElement>('theme')
type Theme = 'light' | 'dark'

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  const label = `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`
  themeButton.setAttribute('aria-label', label)
  themeButton.title = label
}

applyTheme(currentTheme())

themeButton.addEventListener('click', () => {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark'
  applyTheme(next)
  try {
    localStorage.setItem(THEME_KEY, next)
  } catch {}
  notify(next === 'dark' ? 'Dark theme' : 'Light theme')
})

// Until someone picks a theme, follow the operating system.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
  let saved: string | null = null
  try {
    saved = localStorage.getItem(THEME_KEY)
  } catch {}
  if (saved !== 'light' && saved !== 'dark') applyTheme(event.matches ? 'dark' : 'light')
})

// --- Dialogs ---------------------------------------------------------------------

const returnFocus = new WeakMap<HTMLDialogElement, HTMLElement | null>()

function openDialog(dialog: HTMLDialogElement, trigger: HTMLElement | null): void {
  dialog.returnValue = ''
  returnFocus.set(dialog, trigger)
  dialog.showModal()
}

for (const dialog of document.querySelectorAll('dialog')) {
  // Close on backdrop click, but not when a drag that started inside ends outside.
  let pressedBackdrop = false
  dialog.addEventListener('pointerdown', (event) => (pressedBackdrop = event.target === dialog))
  dialog.addEventListener('click', (event) => {
    if (pressedBackdrop && event.target === dialog) dialog.close()
    pressedBackdrop = false
  })
  dialog.addEventListener('close', () => {
    const trigger = returnFocus.get(dialog)
    if (trigger?.isConnected) trigger.focus()
  })
}

// --- Screens ---------------------------------------------------------------------

const boot = $('boot')
const loginSection = $('login')
const loginForm = $<HTMLFormElement>('login-form')
const passwordInput = $<HTMLInputElement>('password')
const loginError = $('login-error')
const loginSubmit = $<HTMLButtonElement>('login-submit')
const dashboard = $('dashboard')
const signOutButton = $<HTMLButtonElement>('sign-out')

const DISABLED_MESSAGE = 'Admin is disabled. Set ADMIN_PASSWORD on the server.'

function setLoginError(message: string): void {
  loginError.textContent = message
  if (message) passwordInput.setAttribute('aria-invalid', 'true')
  else passwordInput.removeAttribute('aria-invalid')
}

function showLogin(message = ''): void {
  abortRooms?.abort()
  for (const dialog of document.querySelectorAll('dialog')) if (dialog.open) dialog.close()
  boot.hidden = true
  dashboard.hidden = true
  signOutButton.hidden = true
  loginSection.hidden = false
  document.title = 'Sign in · CodeHere Admin'
  setLoginError(message)
  passwordInput.focus()
}

function showDashboard(): void {
  boot.hidden = true
  loginSection.hidden = true
  dashboard.hidden = false
  signOutButton.hidden = false
  document.title = 'Admin · CodeHere'
  $('dashboard-heading').focus()
  // Learn the editor's origin (for room links) before the first render; failures fall back to relative links.
  void api
    .checkSession()
    .catch(() => false)
    .then(() => refreshAll())
}

function isDashboardVisible(): boolean {
  return !dashboard.hidden
}

/** Shared error handling for dashboard calls: a 401 means the session is gone. */
function handleError(error: unknown, fallback: string): void {
  if (isAbort(error)) return
  if (error instanceof ApiError && error.status === 401) {
    if (isDashboardVisible()) showLogin('Your session has expired. Sign in again.')
    return
  }
  notify(error instanceof ApiError && error.status === 0 ? error.message : fallback)
}

function loginMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Sign in failed. Try again.'
  switch (error.status) {
    case 401:
      return 'Wrong password'
    case 429:
      return 'Too many attempts, try again in a minute'
    case 404:
      return DISABLED_MESSAGE
    case 0:
      return error.message
    default:
      return `Sign in failed (${error.status}). Try again.`
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const password = passwordInput.value
  if (!password) {
    setLoginError('Enter the password')
    passwordInput.focus()
    return
  }
  loginSubmit.disabled = true
  loginForm.setAttribute('aria-busy', 'true')
  setLoginError('')
  try {
    await api.login(password)
    passwordInput.value = ''
    showDashboard()
  } catch (error) {
    setLoginError(loginMessage(error))
    passwordInput.focus()
    passwordInput.select()
  } finally {
    loginSubmit.disabled = false
    loginForm.removeAttribute('aria-busy')
  }
})

signOutButton.addEventListener('click', async () => {
  try {
    await api.logout()
  } catch {
    // Signing out locally is still the right outcome; the cookie expires on its own.
  }
  showLogin()
  notify('Signed out')
})

// --- Stats -----------------------------------------------------------------------

const statsList = $('stats')

function renderStats(stats: Stats | null): void {
  const value = <T>(fn: (s: Stats) => T): T | string => (stats ? fn(stats) : '—')
  const tiles: [string, string][] = [
    ['Rooms', value((s) => formatNumber(s.totalRooms))],
    ['Active rooms', value((s) => formatNumber(s.activeRooms))],
    ['Connections', value((s) => formatNumber(s.connections))],
  ]
  // Skipped where the backend has no single process to measure (Cloudflare Workers).
  if (stats?.uptimeSeconds != null) tiles.push(['Uptime', formatDuration(stats.uptimeSeconds)])
  if (stats?.memoryRssBytes != null) tiles.push(['Memory (RSS)', formatBytes(stats.memoryRssBytes)])
  tiles.push(
    ['Database', value((s) => (s.dbDriver === 'cloudflare' ? 'Durable Objects' : s.dbDriver))],
    ['Room expiry', value((s) => (s.roomTtlDays > 0 ? `${formatNumber(s.roomTtlDays)} days` : 'Never'))],
    ['Max document', value((s) => (s.maxDocChars > 0 ? `${formatNumber(s.maxDocChars)} chars` : 'Unlimited'))],
  )
  statsList.replaceChildren(...tiles.map(([label, text]) => h('div', { class: 'stat' }, h('dt', {}, label), h('dd', {}, text))))
}

async function loadStats(): Promise<void> {
  try {
    renderStats(await api.getStats())
  } catch (error) {
    renderStats(null)
    handleError(error, 'Could not load stats')
  }
}

// --- Rooms -----------------------------------------------------------------------

const tbody = $('rooms-body')
const caption = $('rooms-caption')
const searchInput = $<HTMLInputElement>('search')
const prevButton = $<HTMLButtonElement>('prev')
const nextButton = $<HTMLButtonElement>('next')
const pageStatus = $('page-status')
const roomsHeading = $('rooms-heading')

let query = ''
let offset = 0
let total = 0
let rooms: RoomSummary[] = []
let abortRooms: AbortController | null = null

function messageRow(text: string): HTMLTableRowElement {
  return h('tr', {}, h('td', { colspan: '7', class: 'empty' }, text))
}

function actionButton(action: string, id: string, label: string, extraClass = ''): HTMLButtonElement {
  return h(
    'button',
    { type: 'button', class: `ghost small ${extraClass}`.trim(), 'data-action': action, 'data-id': id, 'aria-label': `${label} room ${id}` },
    label,
  )
}

function renderRow(room: RoomSummary, now: number): HTMLTableRowElement {
  const link = h(
    'a',
    { href: api.roomUrl(room.id), target: '_blank', rel: 'noopener' },
    room.id,
    h('span', { class: 'sr-only' }, ' (opens in new tab)'),
  )
  const status = room.locked ? h('span', { class: 'badge' }, 'Locked') : h('span', { class: 'muted' }, 'Editable')
  return h(
    'tr',
    {},
    h('th', { scope: 'row', class: 'mono' }, link),
    h('td', {}, timeElement(room.updatedAt, formatRelative(room.updatedAt, now))),
    h('td', {}, timeElement(room.createdAt, formatDate(room.createdAt))),
    h('td', { class: 'num' }, formatBytes(room.sizeBytes)),
    h('td', { class: 'num' }, formatNumber(room.online)),
    h('td', {}, status),
    h(
      'td',
      { class: 'actions' },
      h(
        'div',
        { class: 'row-actions' },
        actionButton('view', room.id, 'View'),
        actionButton('lock', room.id, room.locked ? 'Unlock' : 'Lock'),
        actionButton('delete', room.id, 'Delete', 'destructive'),
      ),
    ),
  )
}

function renderRooms(): void {
  // Re-rendering replaces the buttons; keep keyboard focus on the same action.
  const active = document.activeElement
  const focused = active instanceof HTMLElement && tbody.contains(active) ? { ...active.dataset } : null
  const pagerFocus = active === prevButton || active === nextButton ? (active as HTMLButtonElement) : null

  const now = Date.now()
  if (rooms.length) tbody.replaceChildren(...rooms.map((room) => renderRow(room, now)))
  else tbody.replaceChildren(messageRow(query ? `No rooms start with “${query}”.` : 'No rooms yet.'))

  const first = rooms.length ? offset + 1 : 0
  const last = offset + rooms.length
  const range = rooms.length ? `${formatNumber(first)}–${formatNumber(last)} of ${formatNumber(total)}` : 'No rooms'
  pageStatus.textContent = range
  caption.textContent = `Rooms${query ? ` starting with “${query}”` : ''}, ${range}`
  prevButton.disabled = offset === 0
  nextButton.disabled = offset + rooms.length >= total
  // Reaching the first or last page disables the focused pager button; keep focus nearby.
  if (pagerFocus?.disabled) (pagerFocus === nextButton ? prevButton : nextButton).focus()

  if (focused?.action && focused.id) {
    const match = [...tbody.querySelectorAll<HTMLElement>('[data-action]')].find(
      (button) => button.dataset.action === focused.action && button.dataset.id === focused.id,
    )
    if (match) match.focus()
    else if (!tbody.contains(document.activeElement)) roomsHeading.focus()
  }
}

async function loadRooms(): Promise<void> {
  abortRooms?.abort()
  const controller = new AbortController()
  abortRooms = controller
  tbody.setAttribute('aria-busy', 'true')
  try {
    const page = await api.listRooms(query, offset, PAGE_SIZE, controller.signal)
    // A deletion can leave us past the last page; step back instead of showing an empty one.
    if (!page.rooms.length && offset > 0 && page.total > 0) {
      offset = Math.max(0, Math.floor((page.total - 1) / PAGE_SIZE) * PAGE_SIZE)
      return loadRooms()
    }
    rooms = page.rooms
    total = page.total
    renderRooms()
  } catch (error) {
    if (isAbort(error)) return
    rooms = []
    total = 0
    tbody.replaceChildren(messageRow('Could not load rooms.'))
    pageStatus.textContent = ''
    prevButton.disabled = nextButton.disabled = true
    handleError(error, 'Could not load rooms')
  } finally {
    if (abortRooms === controller) tbody.removeAttribute('aria-busy')
  }
}

function refreshAll(): Promise<unknown> {
  return Promise.all([loadStats(), loadRooms()])
}

let searchTimer = 0
searchInput.addEventListener('input', () => {
  window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    const next = searchInput.value.trim()
    if (next === query) return
    query = next
    offset = 0
    void loadRooms()
  }, 250)
})

prevButton.addEventListener('click', () => {
  offset = Math.max(0, offset - PAGE_SIZE)
  void loadRooms()
})

nextButton.addEventListener('click', () => {
  offset += PAGE_SIZE
  void loadRooms()
})

$('refresh').addEventListener('click', async () => {
  await refreshAll()
  if (isDashboardVisible()) notify('Refreshed')
})

// --- Row actions -----------------------------------------------------------------

const viewDialog = $<HTMLDialogElement>('view-dialog')
const deleteDialog = $<HTMLDialogElement>('delete-dialog')
let pendingDelete: { id: string; trigger: HTMLElement } | null = null

// Ids with a request in flight. Buttons are not disabled, because that would drop keyboard focus.
const busy = new Set<string>()

tbody.addEventListener('click', (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>('button[data-action]')
  const id = button?.dataset.id
  if (!button || !id || busy.has(id)) return
  if (button.dataset.action === 'view') void viewRoom(id, button)
  else if (button.dataset.action === 'lock') void toggleLock(id)
  else if (button.dataset.action === 'delete') confirmDelete(id, button)
})

async function viewRoom(id: string, trigger: HTMLButtonElement): Promise<void> {
  busy.add(id)
  try {
    const room = await api.getRoom(id)
    $('view-id').textContent = room.id
    const meta: [string, Node | string][] = [
      ['Language', room.language ?? 'Plain text'],
      ['Size', formatBytes(room.sizeBytes)],
      ['Last edited', timeElement(room.updatedAt, formatDateTime(room.updatedAt))],
      ['Created', timeElement(room.createdAt, formatDateTime(room.createdAt))],
      ['Online', formatNumber(room.online)],
      ['Status', room.locked ? 'Locked' : 'Editable'],
    ]
    if (room.viewId) meta.push(['View ID', h('code', {}, room.viewId)])
    $('view-meta').replaceChildren(...meta.map(([label, value]) => h('div', {}, h('dt', {}, label), h('dd', {}, value))))
    const pre = $('view-text')
    pre.textContent = room.text || '(empty)'
    pre.scrollTop = 0
    $<HTMLAnchorElement>('view-open').href = api.roomUrl(room.id)
    openDialog(viewDialog, trigger)
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      notify(`Room ${id} no longer exists`)
      void refreshAll()
    } else handleError(error, 'Could not load room')
  } finally {
    busy.delete(id)
  }
}

async function toggleLock(id: string): Promise<void> {
  const room = rooms.find((item) => item.id === id)
  if (!room) return
  const locked = !room.locked
  busy.add(id)
  try {
    await api.setLocked(id, locked)
    await loadRooms()
    notify(`Room ${id} ${locked ? 'locked' : 'unlocked'}`)
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      notify(`Room ${id} no longer exists`)
      void refreshAll()
    } else handleError(error, `Could not ${locked ? 'lock' : 'unlock'} room`)
  } finally {
    busy.delete(id)
  }
}

function confirmDelete(id: string, trigger: HTMLButtonElement): void {
  pendingDelete = { id, trigger }
  $('delete-id').textContent = id
  openDialog(deleteDialog, trigger)
}

$('delete-cancel').addEventListener('click', () => deleteDialog.close())

deleteDialog.addEventListener('close', async () => {
  const target = pendingDelete
  pendingDelete = null
  if (!target || deleteDialog.returnValue !== 'delete') return
  try {
    await api.deleteRoom(target.id)
    notify(`Room ${target.id} deleted`)
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notify(`Room ${target.id} was already deleted`)
    else return handleError(error, 'Could not delete room')
  }
  await refreshAll()
  // The row (and its button) is gone; move focus somewhere predictable.
  if (!target.trigger.isConnected && isDashboardVisible()) roomsHeading.focus()
})

// --- Start -----------------------------------------------------------------------

async function start(): Promise<void> {
  try {
    if (await api.checkSession()) showDashboard()
    else showLogin()
  } catch (error) {
    showLogin(error instanceof ApiError && error.status === 404 ? DISABLED_MESSAGE : loginMessage(error))
  }
}

void start()
