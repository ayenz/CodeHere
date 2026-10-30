import * as decoding from 'lib0/decoding'
import { customAlphabet } from 'nanoid'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import { $, anchorPopover, copyText, readSetting, writeSetting } from './dom'
import { createEditor } from './editor'
import { canFormat, formatCode, minimalChange } from './format'
import { loadIdentity, saveName } from './identity'
import { AUTO, detectLanguage, fileExtension, languageNames, loadLanguage, PLAIN_TEXT } from './languages'
import { describeLines, formatLineHash, lineLinks, parseLineHash, selectedLines, showLines, type LineRange } from './lines'
import { announce, notify } from './notify'
import { createPeople } from './people'
import { setUpSettings } from './settings'
import { setUpThemes } from './theme'

const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{4,32}$/
const newId = customAlphabet('23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ', 8)
const newSecret = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 32)

// Must match the server's MESSAGE_STATUS and close codes (server/src/rooms.ts).
const MESSAGE_STATUS = 100
const CLOSE_NOT_FOUND = 4404
const CLOSE_RATE_LIMITED = 4429

interface RoomStatus {
  readOnly?: boolean
  locked?: boolean
  viewId?: string
  maxDocChars?: number
  error?: string
}

// --- Route: /<roomId> to edit, /v/<viewId> to read along, / to create a room --------

const ownerKey = (id: string) => `codehere:owner:${id}`
const viewMatch = /^\/v\/([^/]+)$/.exec(location.pathname)
const viewing = Boolean(viewMatch)
let roomKey = decodeURIComponent(viewMatch ? viewMatch[1] : location.pathname.slice(1))
if (!ROOM_ID_PATTERN.test(roomKey)) {
  // A brand-new room: remember a secret that proves we created it, so we can delete it later.
  roomKey = newId()
  writeSetting(ownerKey(roomKey), newSecret())
  history.replaceState(null, '', `/${roomKey}`)
}
const ownerToken = viewing ? null : readSetting(ownerKey(roomKey))

document.title = viewing ? 'View only · CodeHere' : `${roomKey} · CodeHere`
document.body.classList.toggle('viewing', viewing)
$('room-id').textContent = viewing ? 'view only' : roomKey

const doc = new Y.Doc()
const ytext = doc.getText('code')
const meta = doc.getMap<string>('meta')
const wsBase = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
const provider = new WebsocketProvider(viewing ? `${wsBase}/v` : wsBase, roomKey, doc, {
  params: ownerToken ? { owner: ownerToken } : {},
})
const awareness = provider.awareness

const identity = loadIdentity()
awareness.setLocalStateField('user', { ...identity, viewer: viewing })

// --- Editor -----------------------------------------------------------------

const position = $('position')
const editor = createEditor($('editor'), ytext, awareness, {
  onSelection(view) {
    const head = view.state.selection.main.head
    const line = view.state.doc.lineAt(head)
    position.textContent = `Ln ${line.number}, Col ${head - line.from + 1}`
  },
  extensions: [lineLinks((range) => setLineLink(range, false))],
})
const getSettings = setUpSettings(editor)
setUpThemes(editor)
const people = createPeople({
  awareness,
  doc,
  view: editor.view,
  localUser: () => ({ ...identity, viewer: viewing }),
})

// --- Permissions: read-only links and locked rooms --------------------------------

// Declared up front: updateAccess() below already shows or hides it.
const formatButton = $<HTMLButtonElement>('format')
const banner = $('banner')
const bannerText = $('banner-text')
let readOnly = viewing
let locked = false
let viewId: string | null = null
let online = false

function updateAccess(): void {
  editor.setReadOnly(readOnly)
  document.body.classList.toggle('read-only', readOnly)
  $<HTMLSelectElement>('language').disabled = readOnly
  updateFormatButton()

  let message = ''
  if (!online && provider.synced) message = "You're offline. Your changes will sync when the connection is back."
  else if (locked) message = 'This room is locked. Nobody can edit it right now.'
  else if (viewing) message = 'View only. You can read along but not edit.'
  banner.hidden = !message
  bannerText.textContent = message
}

let limitWarned = 0
provider.messageHandlers[MESSAGE_STATUS] = (_encoder, decoder) => {
  const status = JSON.parse(decoding.readVarString(decoder)) as RoomStatus
  if (status.error === 'doc-too-large') {
    notify(`This room is limited to ${status.maxDocChars?.toLocaleString()} characters`)
    return
  }
  const wasLocked = locked
  readOnly = Boolean(status.readOnly)
  locked = Boolean(status.locked)
  viewId = status.viewId ?? null
  editor.setDocLimit(status.maxDocChars ?? 0, () => {
    // Typing past the limit fires on every keystroke; warn at most every few seconds.
    if (Date.now() - limitWarned < 4000) return
    limitWarned = Date.now()
    notify(`This room is limited to ${status.maxDocChars?.toLocaleString()} characters`)
  })
  if (wasLocked !== locked && provider.synced) notify(locked ? 'This room was locked' : 'This room was unlocked')
  updateAccess()
  updateShare()
}

// --- Connection, loading and "room gone" states ------------------------------------

const status = $('status')
const editorElement = $('editor')
const STATUS_TEXT: Record<string, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  disconnected: 'Offline',
}

provider.on('status', ({ status: state }: { status: string }) => {
  online = state === 'connected'
  status.dataset.state = state
  status.textContent = STATUS_TEXT[state] ?? state
  updateAccess()
})

// Show a skeleton until the document has arrived, and explain slow connections.
const slowTimer = window.setTimeout(() => {
  if (!provider.synced) status.textContent = 'Still connecting… check your network'
}, 4000)

provider.once('sync', () => {
  window.clearTimeout(slowTimer)
  editorElement.removeAttribute('data-loading')
  editorElement.removeAttribute('aria-busy')
  // Stay quiet while the initial document and presence load; only announce later changes.
  window.setTimeout(() => people.startAnnouncing(), 1000)
  applyLineHash(true)
  updateAccess()
  if (!readOnly) editor.view.focus()
})

provider.on('connection-close', (event: CloseEvent | null) => {
  if (event?.code === CLOSE_NOT_FOUND) showGone(event.reason === 'Room deleted')
  else if (event?.code === CLOSE_RATE_LIMITED) {
    status.textContent = 'Too many connections — try again later'
    notify('The server is limiting connections. Try again in a little while.')
  }
})

function showGone(deleted: boolean): void {
  provider.destroy()
  writeSetting(ownerKey(roomKey), null)
  document.body.classList.add('gone')
  $('gone').hidden = false
  $('gone-title').textContent = deleted ? 'This room was deleted' : "This room doesn't exist"
  $('gone-text').textContent = deleted
    ? 'Its code was removed for everyone and its links no longer work.'
    : 'It may have been deleted, or the link is mistyped.'
  status.dataset.state = 'disconnected'
  status.textContent = 'Not connected'
  banner.hidden = true
  $<HTMLAnchorElement>('gone-new').focus()
}

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
  updateFormatButton()

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
  if (provider.synced && !event.transaction.local) {
    const chosen = chosenLanguage()
    notify(chosen === AUTO ? 'Language set to auto-detect' : `Language changed to ${chosen}`)
  }
})
ytext.observe(scheduleDetection)
languageSelect.addEventListener('change', () => meta.set('language', languageSelect.value))
scheduleDetection()
void applyLanguage()

// --- Format with Prettier --------------------------------------------------------

function updateFormatButton(): void {
  formatButton.hidden = readOnly || !canFormat(effectiveLanguage())
}

async function formatDocument(): Promise<void> {
  const language = effectiveLanguage()
  if (readOnly || !canFormat(language)) return
  const before = editor.view.state.doc.toString()
  try {
    const { indent } = getSettings()
    const formatted = await formatCode(before, language, { tabWidth: indent === 0 ? 4 : indent })
    // Someone may have edited while Prettier ran; formatting stale text would undo their work.
    if (editor.view.state.doc.toString() !== before) {
      notify('The code changed while formatting. Try again.')
      return
    }
    const change = minimalChange(before, formatted)
    if (!change) {
      notify('Already formatted')
      return
    }
    editor.view.dispatch({ changes: change, userEvent: 'format' })
    notify(`Formatted as ${language}`)
  } catch (error) {
    notify(`Can't format: ${error instanceof Error ? error.message : 'syntax error'}`)
  }
}
formatButton.addEventListener('click', () => void formatDocument())
window.addEventListener('keydown', (event) => {
  // Shift+Alt+F, the same shortcut as VS Code.
  if (event.shiftKey && event.altKey && event.code === 'KeyF') {
    event.preventDefault()
    void formatDocument()
  }
})

// --- Links to lines (#L10 or #L10-L20) ------------------------------------------------

let linkedRange: LineRange | null = null

function setLineLink(range: LineRange | null, scroll: boolean): void {
  linkedRange = range
  const url = `${location.pathname}${range ? formatLineHash(range) : ''}`
  history.replaceState(null, '', url)
  showLines(editor.view, range, scroll)
  if (range && !scroll) announce(`Selected ${describeLines(range)}. Share the link to point others to it.`)
  updateShare()
}

function applyLineHash(scroll: boolean): void {
  const range = parseLineHash(location.hash)
  linkedRange = range
  showLines(editor.view, range, scroll)
}
window.addEventListener('hashchange', () => applyLineHash(true))

// --- Share popover -------------------------------------------------------------------

const sharePopover = $('share-popover')
anchorPopover(sharePopover, $('share-button'))
const editUrl = $<HTMLInputElement>('share-edit-url')
const viewUrl = $<HTMLInputElement>('share-view-url')

function linkFor(path: string): string {
  return `${location.origin}${path}${linkedRange ? formatLineHash(linkedRange) : ''}`
}

function updateShare(): void {
  $('share-edit').hidden = viewing
  editUrl.value = linkFor(`/${roomKey}`)
  const viewPath = viewing ? `/v/${roomKey}` : viewId ? `/v/${viewId}` : null
  $('share-view').hidden = !viewPath
  viewUrl.value = viewPath ? linkFor(viewPath) : ''
  $('share-lines-note').hidden = !linkedRange
  $('share-lines-note').textContent = linkedRange ? `Links point to ${describeLines(linkedRange)}.` : ''
}
sharePopover.addEventListener('toggle', updateShare)

$('copy-edit').addEventListener('click', async () => {
  if (await copyText(editUrl.value)) notify('Edit link copied — anyone with it can edit')
})
$('copy-view').addEventListener('click', async () => {
  if (await copyText(viewUrl.value)) notify('View-only link copied')
})
$('link-lines').addEventListener('click', () => {
  setLineLink(selectedLines(editor.view), false)
  editor.view.focus()
  notify(`Links now point to ${describeLines(linkedRange!)}`)
})
updateShare()

// --- Download ---------------------------------------------------------------------

$('download').addEventListener('click', () => {
  const blob = new Blob([ytext.toString()], { type: 'text/plain;charset=utf-8' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `${viewing ? 'code' : roomKey}.${fileExtension(effectiveLanguage())}`
  link.click()
  URL.revokeObjectURL(link.href)
})

// --- Delete room (only the browser that created it) ------------------------------------

const deleteButton = $<HTMLButtonElement>('delete-room')
const deleteDialog = $<HTMLDialogElement>('delete-dialog')
deleteButton.hidden = !ownerToken

deleteButton.addEventListener('click', () => {
  deleteDialog.returnValue = ''
  deleteDialog.showModal()
})
$('delete-cancel').addEventListener('click', () => deleteDialog.close('cancel'))
deleteDialog.addEventListener('click', (event) => {
  if (event.target === deleteDialog) deleteDialog.close('cancel')
})
deleteDialog.addEventListener('close', async () => {
  if (deleteDialog.returnValue !== 'delete' || !ownerToken) {
    deleteButton.focus()
    return
  }
  const response = await fetch(`/api/rooms/${encodeURIComponent(roomKey)}`, {
    method: 'DELETE',
    headers: { 'x-requested-with': 'codehere', 'x-owner-token': ownerToken },
  }).catch(() => null)
  if (response?.status === 204 || response?.status === 404) showGone(true)
  else notify("Couldn't delete the room. Try again.")
})

// --- Rename -------------------------------------------------------------------------

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
  awareness.setLocalStateField('user', { ...identity, viewer: viewing })
  people.refresh()
  notify(`You're now ${name}`)
})

// Runs last so every piece of state it reads has been declared.
updateAccess()
