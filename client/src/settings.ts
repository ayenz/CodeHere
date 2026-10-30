import type { Extension } from '@codemirror/state'
import { $, anchorPopover, readSetting, writeSetting } from './dom'
import type { Editor, EditorSettings } from './editor'
import { notify } from './notify'

const SETTINGS_KEY = 'codehere:editor-settings'
const KEYMAP_KEY = 'codehere:keymap'

const DEFAULTS: EditorSettings = { fontSize: 14, wrap: false, indent: 2 }
const FONT_SIZES = [12, 13, 14, 15, 16, 18, 20]
const INDENTS: Array<[number, string]> = [
  [2, '2 spaces'],
  [4, '4 spaces'],
  [0, 'Tabs'],
]

type KeymapName = 'default' | 'vim' | 'emacs'

async function loadKeymap(name: KeymapName): Promise<Extension> {
  if (name === 'vim') return (await import('@replit/codemirror-vim')).vim()
  if (name === 'emacs') return (await import('@replit/codemirror-emacs')).emacs()
  return []
}

function readSettings(): EditorSettings {
  try {
    const saved = JSON.parse(readSetting(SETTINGS_KEY) ?? '{}') as Partial<EditorSettings>
    return {
      fontSize: FONT_SIZES.includes(Number(saved.fontSize)) ? Number(saved.fontSize) : DEFAULTS.fontSize,
      wrap: typeof saved.wrap === 'boolean' ? saved.wrap : DEFAULTS.wrap,
      indent: INDENTS.some(([value]) => value === saved.indent) ? Number(saved.indent) : DEFAULTS.indent,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

/** Wires the editor settings popover. Returns a getter for the current settings. */
export function setUpSettings(editor: Editor): () => EditorSettings {
  const popover = $('settings-popover')
  anchorPopover(popover, $('settings-button'))
  const fontSize = $<HTMLSelectElement>('setting-font-size')
  const indent = $<HTMLSelectElement>('setting-indent')
  const keymapSelect = $<HTMLSelectElement>('setting-keymap')
  const wrap = $<HTMLInputElement>('setting-wrap')

  for (const size of FONT_SIZES) fontSize.add(new Option(`${size}px`, String(size)))
  for (const [value, label] of INDENTS) indent.add(new Option(label, String(value)))

  let settings = readSettings()
  fontSize.value = String(settings.fontSize)
  indent.value = String(settings.indent)
  wrap.checked = settings.wrap
  editor.setSettings(settings)

  function update(): void {
    settings = { fontSize: Number(fontSize.value), indent: Number(indent.value), wrap: wrap.checked }
    writeSetting(SETTINGS_KEY, JSON.stringify(settings))
    editor.setSettings(settings)
  }
  fontSize.addEventListener('change', update)
  indent.addEventListener('change', update)
  wrap.addEventListener('change', update)

  let keymapName = (readSetting(KEYMAP_KEY) ?? 'default') as KeymapName
  if (!['default', 'vim', 'emacs'].includes(keymapName)) keymapName = 'default'
  keymapSelect.value = keymapName
  async function applyKeymap(name: KeymapName, announceChange: boolean): Promise<void> {
    keymapName = name
    const extension = await loadKeymap(name)
    if (keymapName !== name) return
    editor.setKeymap(extension)
    if (announceChange) notify(name === 'default' ? 'Default key bindings' : `${name === 'vim' ? 'Vim' : 'Emacs'} key bindings`)
  }
  keymapSelect.addEventListener('change', () => {
    const name = keymapSelect.value as KeymapName
    writeSetting(KEYMAP_KEY, name)
    void applyKeymap(name, true)
  })
  if (keymapName !== 'default') void applyKeymap(keymapName, false)

  return () => settings
}
