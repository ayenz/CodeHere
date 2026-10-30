import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import type { Extension } from '@codemirror/state'

export const PLAIN_TEXT = 'Plain Text'

export const languageNames: string[] = [
  PLAIN_TEXT,
  ...languages.map((language) => language.name).sort((a, b) => a.localeCompare(b)),
]

function find(name: string): LanguageDescription | null {
  return languages.find((language) => language.name === name) ?? null
}

/** Loads the language support lazily so only the languages people use are downloaded. */
export async function loadLanguage(name: string): Promise<Extension> {
  const description = find(name)
  if (!description) return []
  return description.support ?? (await description.load())
}

export function fileExtension(name: string): string {
  return find(name)?.extensions[0] ?? 'txt'
}

/** Stored in the room when the language should be detected from the code. */
export const AUTO = 'auto'

const MIN_DETECT_LENGTH = 12

/**
 * Guesses the language of `text`. Returns PLAIN_TEXT for an empty document and
 * null when the text is too short or ambiguous to change the current guess.
 */
export async function detectLanguage(text: string): Promise<string | null> {
  if (text.trim() === '') return PLAIN_TEXT
  if (text.length < MIN_DETECT_LENGTH) return null
  // Loaded on first use so rooms with an explicit language never download it.
  const { default: flourite } = await import('flourite')
  const { language } = flourite(text.slice(0, 20_000), { heuristic: true })
  if (language === 'Unknown') return null
  // flourite names differ from CodeMirror's only in letter case (e.g. "Javascript").
  return languageNames.find((name) => name.toLowerCase() === language.toLowerCase()) ?? null
}
