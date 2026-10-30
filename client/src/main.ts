import { customAlphabet } from 'nanoid'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import { createEditor } from './editor'
import { DEFAULT_EDITOR_THEME, editorThemes, findEditorTheme } from './editor-themes'
import { loadIdentity, saveName } from './identity'
import { AUTO, detectLanguage, fileExtension, languageNames, loadLanguage, PLAIN_TEXT } from './languages'

const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{4,32}$/
const newRoomId = customAlphabet('23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ', 8)

function $<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing #${id}`)
  return element as T
}

// --- Room -------------------------------------------------------------------

let roomId = decodeURIComponent(location.pathname.slice(1))
if (!ROOM_ID_PATTERN.test(roomId)) {
  roomId = newRoomId()
  history.replaceState(null, '', `/${roomId}`)
}
document.title = `${roomId} · CodeHere`
$('room-id').textContent = roomId

const doc = new Y.Doc()
const ytext = doc.getText('code')
const meta = doc.getMap<string>('meta')
const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
const provider = new WebsocketProvider(wsUrl, roomId, doc)
const awareness = provider.awareness

const identity = loadIdentity()
awareness.setLocalStateField('user', identity)

// --- Announcements for screen readers ----------------------------------------

const announcer = $('announcer')
// Stay quiet while the initial document and presence load; only announce later changes.
let announcing = false
provider.once('sync', () => window.setTimeout(() => (announcing = true), 1000))

function announce(message: string): void {
  // Clearing first makes repeated identical messages announce again.
  announcer.textContent = ''
  window.setTimeout(() => (announcer.textContent = message), 50)
}

const toastElement = $('toast')
let toastTimer = 0
/** Shows a short message on screen and announces it to screen readers. */
function notify(message: string): void {
  announce(message)
  toastElement.textContent = message
  toastElement.classList.add('visible')
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => toastElement.classList.remove('visible'), 1800)
}

// --- Editor -----------------------------------------------------------------

const position = $('position')
const editor = createEditor($('editor'), ytext, awareness, (view) => {
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  position.textContent = `Ln ${line.number}, Col ${head - line.from + 1}`
})

// --- Language (shared by everyone in the room) --------------------------------

// The room stores either an explicit language or AUTO. In auto mode every client detects
// the language from the same shared text, so they agree without syncing the result.
const languageSelect = $<HTMLSelectElement>('language')
const autoOption = new Option('Auto-detect', AUTO)
languageSelect.add(autoOption)
for (const name of languageNames) languageSelect.add(new Option(name, name))

let detectedLanguage = PLAIN_TEXT
let appliedLanguage = ''

function chosenLanguage(): string {
  return meta.get('language') ?? AUTO
}

/** The language actually in effect: the explicit choice, or the detected one in auto mode. */
function effectiveLanguage(): string {
  const chosen = chosenLanguage()
  return chosen === AUTO ? detectedLanguage : chosen
}

async function applyLanguage(): Promise<void> {
  const chosen = chosenLanguage()
  languageSelect.value = chosen
  autoOption.text = chosen === AUTO && detectedLanguage !== PLAIN_TEXT ? `Auto · ${detectedLanguage}` : 'Auto-detect'

  const name = effectiveLanguage()
  if (name === appliedLanguage) return
  appliedLanguage = name
  const extension = await loadLanguage(name)
  // A newer change may have arrived while this one was loading.
  if (appliedLanguage === name) editor.setLanguage(extension)
}

let detectTimer = 0
function scheduleDetection(): void {
  if (chosenLanguage() !== AUTO) return
  window.clearTimeout(detectTimer)
  detectTimer = window.setTimeout(async () => {
    const detected = await detectLanguage(ytext.toString())
    // Keep the previous guess when the text is too ambiguous to tell.
    if (detected && detected !== detectedLanguage) {
      detectedLanguage = detected
      void applyLanguage()
    }
  }, 600)
}

meta.observe((event) => {
  scheduleDetection()
  void applyLanguage()
  if (announcing && !event.transaction.local) {
    const chosen = chosenLanguage()
    notify(chosen === AUTO ? 'Language set to auto-detect' : `Language changed to ${chosen}`)
  }
})
ytext.observe(scheduleDetection)
languageSelect.addEventListener('change', () => meta.set('language', languageSelect.value))
scheduleDetection()
void applyLanguage()

// --- Connection status ---------------------------------------------------------

const status = $('status')
const STATUS_TEXT: Record<string, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  disconnected: 'Offline — changes will sync when you reconnect',
}
provider.on('status', ({ status: state }: { status: string }) => {
  status.dataset.state = state
  status.textContent = STATUS_TEXT[state] ?? state
})

// --- People in the room ---------------------------------------------------------

interface PeerState {
  user?: { name: string; color: string }
}

const people = $<HTMLUListElement>('people')
const youButton = $<HTMLButtonElement>('rename')
const youInitial = $('you-initial')
const youLabel = $('you-label')
let knownPeers = new Map<number, string>()

function renderPeople(): void {
  const peers = new Map<number, { name: string; color: string }>()
  awareness.getStates().forEach((state: PeerState, clientId) => {
    if (clientId !== doc.clientID && state.user) peers.set(clientId, state.user)
  })

  people.replaceChildren(
    ...[...peers.values()].map((peer) => {
      const item = document.createElement('li')
      item.className = 'person'
      item.title = peer.name
      item.style.setProperty('--person-color', peer.color)
      // Sighted users see the initial (and a tooltip); screen readers read the full name.
      const initial = document.createElement('span')
      initial.setAttribute('aria-hidden', 'true')
      initial.textContent = peer.name.trim().charAt(0).toUpperCase() || '?'
      const label = document.createElement('span')
      label.className = 'sr-only'
      label.textContent = peer.name
      item.append(initial, label)
      return item
    }),
  )

  if (announcing) {
    for (const [clientId, user] of peers) {
      if (!knownPeers.has(clientId)) notify(`${user.name} joined`)
    }
    for (const [clientId, name] of knownPeers) {
      if (!peers.has(clientId)) notify(`${name} left`)
    }
  }
  knownPeers = new Map([...peers].map(([clientId, user]) => [clientId, user.name]))

  youButton.style.setProperty('--person-color', identity.color)
  youButton.title = `${identity.name} (you) — change name`
  youInitial.textContent = identity.name.trim().charAt(0).toUpperCase() || '?'
  youLabel.textContent = `${identity.name} (you), change name`
}
awareness.on('change', renderPeople)
renderPeople()

// --- Rename -----------------------------------------------------------------

const nameDialog = $<HTMLDialogElement>('name-dialog')
const nameInput = $<HTMLInputElement>('name-input')
$('rename').addEventListener('click', () => {
  nameInput.value = identity.name
  // Reset so closing with Esc or a click outside never reuses an earlier "save".
  nameDialog.returnValue = ''
  nameDialog.showModal()
  nameInput.select()
})
// Cancel is type="button" so that pressing Enter submits Save, the form's default button.
$('name-cancel').addEventListener('click', () => nameDialog.close('cancel'))
// Clicking the backdrop cancels. The form fills the dialog, so only backdrop clicks target it.
nameDialog.addEventListener('click', (event) => {
  if (event.target === nameDialog) nameDialog.close('cancel')
})
nameDialog.addEventListener('close', () => {
  const name = nameInput.value.trim()
  if (nameDialog.returnValue !== 'save' || !name) return
  identity.name = name
  saveName(name)
  awareness.setLocalStateField('user', identity)
  renderPeople()
  notify(`You're now ${name}`)
})

// --- Copy link / download ---------------------------------------------------------

$('copy-link').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href)
    notify('Link copied — send it to anyone to edit together')
  } catch {
    window.prompt('Copy this link', location.href)
  }
})

$('download').addEventListener('click', () => {
  const language = effectiveLanguage()
  const blob = new Blob([ytext.toString()], { type: 'text/plain;charset=utf-8' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `${roomId}.${fileExtension(language)}`
  link.click()
  URL.revokeObjectURL(link.href)
})

// --- Theme ------------------------------------------------------------------
// Two personal preferences: the app theme (light/dark) and the editor colour theme.
// "Default" editor colours follow the app theme; any other editor theme switches the
// app to its matching light/dark mode so the page never looks mismatched.

type Theme = 'light' | 'dark'
const THEME_KEY = 'codehere:theme'
const EDITOR_THEME_KEY = 'codehere:editor-theme'
const themeButton = $<HTMLButtonElement>('theme')
const editorThemeSelect = $<HTMLSelectElement>('editor-theme')
const systemDark = window.matchMedia('(prefers-color-scheme: dark)')

function readSetting(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeSetting(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // The setting still applies for this page view.
  }
}

function savedTheme(): Theme | null {
  const value = readSetting(THEME_KEY)
  return value === 'light' || value === 'dark' ? value : null
}

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  const label = `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`
  themeButton.setAttribute('aria-label', label)
  themeButton.title = label
}

let editorThemeId = DEFAULT_EDITOR_THEME
async function applyEditorTheme(id: string): Promise<void> {
  const choice = findEditorTheme(id)
  editorThemeId = choice ? choice.id : DEFAULT_EDITOR_THEME
  editorThemeSelect.value = editorThemeId
  if (!choice) {
    editor.setTheme(null)
    return
  }
  const extension = await choice.load()
  // Ignore a theme that finished loading after another one was picked.
  if (editorThemeId === choice.id) editor.setTheme(extension)
}

editorThemeSelect.add(new Option('Default', DEFAULT_EDITOR_THEME))
for (const dark of [false, true]) {
  const group = document.createElement('optgroup')
  group.label = dark ? 'Dark' : 'Light'
  for (const theme of editorThemes.filter((item) => item.dark === dark)) group.append(new Option(theme.name, theme.id))
  editorThemeSelect.append(group)
}

editorThemeSelect.addEventListener('change', () => {
  const choice = findEditorTheme(editorThemeSelect.value)
  writeSetting(EDITOR_THEME_KEY, editorThemeSelect.value)
  if (choice) {
    const mode: Theme = choice.dark ? 'dark' : 'light'
    applyTheme(mode)
    writeSetting(THEME_KEY, mode)
  }
  void applyEditorTheme(editorThemeSelect.value)
  notify(`Editor theme: ${choice?.name ?? 'Default'}`)
})

themeButton.addEventListener('click', () => {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark'
  applyTheme(next)
  writeSetting(THEME_KEY, next)
  // An editor theme made for the other mode would clash, so fall back to the default.
  const editorTheme = findEditorTheme(editorThemeId)
  if (editorTheme && editorTheme.dark !== (next === 'dark')) {
    writeSetting(EDITOR_THEME_KEY, DEFAULT_EDITOR_THEME)
    void applyEditorTheme(DEFAULT_EDITOR_THEME)
  }
  notify(next === 'dark' ? 'Dark theme' : 'Light theme')
})

// Until someone picks a theme, follow the operating system.
systemDark.addEventListener('change', (event) => {
  if (!savedTheme()) applyTheme(event.matches ? 'dark' : 'light')
})
applyTheme(savedTheme() ?? (systemDark.matches ? 'dark' : 'light'))
void applyEditorTheme(readSetting(EDITOR_THEME_KEY) ?? DEFAULT_EDITOR_THEME)

// Focus the editor on load so people can start typing right away.
editor.view.focus()
