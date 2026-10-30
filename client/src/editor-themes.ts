import type { Extension } from '@codemirror/state'

export const DEFAULT_EDITOR_THEME = 'default'

export interface EditorTheme {
  id: string
  name: string
  dark: boolean
  /** Loaded on demand so only the chosen theme is downloaded. */
  load(): Promise<Extension>
}

export const editorThemes: EditorTheme[] = [
  { id: 'github-light', name: 'GitHub Light', dark: false, load: async () => (await import('@uiw/codemirror-theme-github')).githubLight },
  { id: 'vscode-light', name: 'VS Code Light', dark: false, load: async () => (await import('@uiw/codemirror-theme-vscode')).vscodeLight },
  { id: 'xcode-light', name: 'Xcode Light', dark: false, load: async () => (await import('@uiw/codemirror-theme-xcode')).xcodeLight },
  { id: 'solarized-light', name: 'Solarized Light', dark: false, load: async () => (await import('@uiw/codemirror-theme-solarized')).solarizedLight },
  { id: 'material-light', name: 'Material Light', dark: false, load: async () => (await import('@uiw/codemirror-theme-material')).materialLight },
  { id: 'gruvbox-light', name: 'Gruvbox Light', dark: false, load: async () => (await import('@uiw/codemirror-theme-gruvbox-dark')).gruvboxLight },

  { id: 'one-dark', name: 'One Dark', dark: true, load: async () => (await import('@codemirror/theme-one-dark')).oneDark },
  { id: 'github-dark', name: 'GitHub Dark', dark: true, load: async () => (await import('@uiw/codemirror-theme-github')).githubDark },
  { id: 'vscode-dark', name: 'VS Code Dark', dark: true, load: async () => (await import('@uiw/codemirror-theme-vscode')).vscodeDark },
  { id: 'dracula', name: 'Dracula', dark: true, load: async () => (await import('@uiw/codemirror-theme-dracula')).dracula },
  { id: 'tokyo-night', name: 'Tokyo Night', dark: true, load: async () => (await import('@uiw/codemirror-theme-tokyo-night')).tokyoNight },
  { id: 'nord', name: 'Nord', dark: true, load: async () => (await import('@uiw/codemirror-theme-nord')).nord },
  { id: 'monokai', name: 'Monokai', dark: true, load: async () => (await import('@uiw/codemirror-theme-monokai')).monokai },
  { id: 'material-dark', name: 'Material Dark', dark: true, load: async () => (await import('@uiw/codemirror-theme-material')).materialDark },
  { id: 'gruvbox-dark', name: 'Gruvbox Dark', dark: true, load: async () => (await import('@uiw/codemirror-theme-gruvbox-dark')).gruvboxDark },
  { id: 'solarized-dark', name: 'Solarized Dark', dark: true, load: async () => (await import('@uiw/codemirror-theme-solarized')).solarizedDark },
  { id: 'xcode-dark', name: 'Xcode Dark', dark: true, load: async () => (await import('@uiw/codemirror-theme-xcode')).xcodeDark },
]

export function findEditorTheme(id: string): EditorTheme | null {
  return editorThemes.find((theme) => theme.id === id) ?? null
}
