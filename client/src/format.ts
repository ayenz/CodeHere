import type { Plugin } from 'prettier'

type PluginName = 'angular' | 'babel' | 'estree' | 'html' | 'markdown' | 'postcss' | 'typescript' | 'yaml'

// Each loader is a separate dynamic import so Vite emits one lazy chunk per plugin.
const pluginLoaders: Record<PluginName, () => Promise<Plugin>> = {
  angular: () => import('prettier/plugins/angular'),
  babel: () => import('prettier/plugins/babel'),
  estree: () => import('prettier/plugins/estree'),
  html: () => import('prettier/plugins/html'),
  markdown: () => import('prettier/plugins/markdown'),
  postcss: () => import('prettier/plugins/postcss'),
  typescript: () => import('prettier/plugins/typescript'),
  yaml: () => import('prettier/plugins/yaml'),
}

interface Target {
  parser: string
  plugins: PluginName[]
}

// Markup and Markdown embed scripts, styles and code blocks, which Prettier formats only if those plugins are loaded.
const embedded: PluginName[] = ['babel', 'estree', 'postcss', 'typescript']

/** Keyed by CodeMirror language-data names. */
const targets: Record<string, Target> = {
  JavaScript: { parser: 'babel', plugins: ['babel', 'estree'] },
  JSX: { parser: 'babel', plugins: ['babel', 'estree'] },
  TypeScript: { parser: 'typescript', plugins: ['typescript', 'estree'] },
  TSX: { parser: 'typescript', plugins: ['typescript', 'estree'] },
  JSON: { parser: 'json', plugins: ['babel', 'estree'] },
  'JSON-LD': { parser: 'json', plugins: ['babel', 'estree'] },
  CSS: { parser: 'css', plugins: ['postcss'] },
  SCSS: { parser: 'scss', plugins: ['postcss'] },
  LESS: { parser: 'less', plugins: ['postcss'] },
  HTML: { parser: 'html', plugins: ['html', ...embedded] },
  Vue: { parser: 'vue', plugins: ['html', ...embedded] },
  'Angular Template': { parser: 'angular', plugins: ['html', 'angular', ...embedded] },
  Markdown: { parser: 'markdown', plugins: ['markdown', 'yaml', ...embedded] },
  YAML: { parser: 'yaml', plugins: ['yaml'] },
}

export function canFormat(language: string): boolean {
  return Object.hasOwn(targets, language)
}

const ANSI = /\u001b\[[0-9;]*m/g

export async function formatCode(text: string, language: string, options: { tabWidth?: number } = {}): Promise<string> {
  const target = targets[language]
  if (!target) throw new Error(`Formatting ${language} is not supported`)
  const [prettier, ...plugins] = await Promise.all([
    import('prettier/standalone'),
    ...target.plugins.map((name) => pluginLoaders[name]()),
  ])
  try {
    return await prettier.format(text, {
      parser: target.parser,
      plugins,
      ...(options.tabWidth === undefined ? {} : { tabWidth: options.tabWidth }),
    })
  } catch (error) {
    // Prettier appends a code frame after the first line; the editor already shows the code.
    const message = (error instanceof Error ? error.message : String(error)).replace(ANSI, '')
    const firstLine = message.split('\n').find((line) => line.trim() !== '')?.trim()
    throw new Error(firstLine || 'Could not format the code')
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

export function minimalChange(before: string, after: string): { from: number; to: number; insert: string } | null {
  if (before === after) return null
  const max = Math.min(before.length, after.length)
  let prefix = 0
  while (prefix < max && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++
  if (prefix > 0 && isHighSurrogate(before.charCodeAt(prefix - 1))) prefix--
  let suffix = 0
  while (
    suffix < max - prefix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix++
  }
  if (suffix > 0 && isLowSurrogate(before.charCodeAt(before.length - suffix))) suffix--
  return {
    from: prefix,
    to: before.length - suffix,
    insert: after.slice(prefix, after.length - suffix),
  }
}
