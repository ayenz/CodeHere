// Two personal preferences: the app theme (light/dark) and the editor colour theme.
// "Default" editor colours follow the app theme; any other editor theme switches the
// app to its matching light/dark mode so the page never looks mismatched.
import { $, readSetting, writeSetting } from './dom'
import type { Editor } from './editor'
import { DEFAULT_EDITOR_THEME, editorThemes, findEditorTheme } from './editor-themes'
import { notify } from './notify'

type Theme = 'light' | 'dark'
const THEME_KEY = 'codehere:theme'
const EDITOR_THEME_KEY = 'codehere:editor-theme'

export function setUpThemes(editor: Editor): void {
  const themeButton = $<HTMLButtonElement>('theme')
  const editorThemeSelect = $<HTMLSelectElement>('editor-theme')
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)')

  function savedTheme(): Theme | null {
    const value = readSetting(THEME_KEY)
    return value === 'light' || value === 'dark' ? value : null
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
    const next: Theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
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
}
