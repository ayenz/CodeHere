import { $ } from './dom'

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

// "Mod" is Cmd on macOS and Ctrl elsewhere, as in CodeMirror's keymaps.
const MAC_SYMBOLS: Record<string, string> = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' }
const OTHER_NAMES: Record<string, string> = { Mod: 'Ctrl' }

// macOS lists modifiers in a fixed order: Control, Option, Shift, Command.
const MAC_ORDER = ['Ctrl', 'Alt', 'Shift', 'Mod']

/** Human-readable shortcut for this platform, e.g. "⌥⇧F" on macOS and "Shift+Alt+F" elsewhere. */
export function shortcutLabel(keys: string[]): string {
  if (!isMac) return keys.map((key) => OTHER_NAMES[key] ?? key).join('+')
  const rank = (key: string) => (MAC_ORDER.includes(key) ? MAC_ORDER.indexOf(key) : MAC_ORDER.length)
  return [...keys]
    .sort((a, b) => rank(a) - rank(b))
    .map((key) => MAC_SYMBOLS[key] ?? key)
    .join('')
}

export const FORMAT_KEYS = ['Shift', 'Alt', 'F']

interface Shortcut {
  /** Alternatives, each a list of keys; a string is shown as plain text (for mouse actions). */
  keys: Array<string[] | string>
  action: string
}

const GROUPS: Array<[string, Shortcut[]]> = [
  [
    'General',
    [
      { keys: [['F1'], ['?']], action: 'Show keyboard shortcuts' },
      { keys: [FORMAT_KEYS], action: 'Format the code (JavaScript, TypeScript, JSON, CSS, HTML, Markdown, YAML…)' },
      { keys: ['Esc, then Tab'], action: 'Leave the editor to reach the rest of the page' },
    ],
  ],
  [
    'Editing',
    [
      { keys: [['Mod', 'Z']], action: 'Undo your own changes' },
      { keys: isMac ? [['Mod', 'Shift', 'Z']] : [['Mod', 'Y'], ['Mod', 'Shift', 'Z']], action: 'Redo' },
      { keys: [['Mod', '/']], action: 'Toggle comment' },
      { keys: [['Tab'], ['Shift', 'Tab']], action: 'Indent / outdent' },
      { keys: [['Alt', '↑'], ['Alt', '↓']], action: 'Move line up / down' },
      { keys: [['Shift', 'Alt', '↑'], ['Shift', 'Alt', '↓']], action: 'Copy line up / down' },
      { keys: [['Mod', 'Shift', 'K']], action: 'Delete line' },
      { keys: [isMac ? ['Ctrl', 'L'] : ['Alt', 'L']], action: 'Select line' },
      { keys: [['Mod', 'D']], action: 'Select next occurrence' },
      { keys: [['Mod', 'Alt', '↑'], ['Mod', 'Alt', '↓']], action: 'Add cursor above / below' },
      { keys: [`${isMac ? '⌘' : 'Ctrl'}+click`], action: 'Add a cursor where you click' },
    ],
  ],
  [
    'Search',
    [
      { keys: [['Mod', 'F']], action: 'Find and replace' },
      { keys: [['Mod', 'G'], ['F3']], action: 'Find next' },
      { keys: [['Mod', 'Alt', 'G']], action: 'Go to line' },
    ],
  ],
  [
    'Together',
    [
      { keys: ['Click an avatar'], action: "Follow that person's cursor" },
      { keys: ['Click a line number'], action: 'Point the share links at that line (Shift+click for a range)' },
    ],
  ],
]

function keysCell(alternatives: Shortcut['keys']): HTMLElement {
  const cell = document.createElement('td')
  alternatives.forEach((keys, index) => {
    if (index > 0) cell.append(' or ')
    if (typeof keys === 'string') {
      cell.append(keys)
      return
    }
    const kbd = document.createElement('kbd')
    kbd.textContent = shortcutLabel(keys)
    cell.append(kbd)
  })
  return cell
}

/** Builds the shortcuts dialog and opens it on F1 or "?" (outside text fields). */
export function setUpShortcuts(): { open(): void } {
  const dialog = $<HTMLDialogElement>('shortcuts-dialog')
  const body = $('shortcuts-body')
  let returnFocus: HTMLElement | null = null

  body.replaceChildren(
    ...GROUPS.map(([title, shortcuts]) => {
      const table = document.createElement('table')
      table.className = 'shortcuts'
      const caption = table.createCaption()
      caption.textContent = title
      const tbody = table.createTBody()
      for (const shortcut of shortcuts) {
        const row = tbody.insertRow()
        const action = document.createElement('th')
        action.scope = 'row'
        action.textContent = shortcut.action
        row.append(action, keysCell(shortcut.keys))
      }
      return table
    }),
  )

  function open(): void {
    if (dialog.open) return
    returnFocus = document.activeElement as HTMLElement | null
    dialog.showModal()
  }

  $('shortcuts-close').addEventListener('click', () => dialog.close())
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close()
  })
  dialog.addEventListener('close', () => returnFocus?.focus())
  $('shortcuts-button').addEventListener('click', open)

  window.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null
    const typing = target?.closest('input, textarea, select, [contenteditable="true"]')
    if (event.key === 'F1' || (event.key === '?' && !typing && !event.ctrlKey && !event.metaKey && !event.altKey)) {
      event.preventDefault()
      open()
    }
  })

  return { open }
}
