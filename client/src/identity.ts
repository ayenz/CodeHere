// Colours are bright enough that dark label text on them passes WCAG AA contrast.
const COLORS = ['#f59e0b', '#34d399', '#60a5fa', '#f472b6', '#a78bfa', '#fb923c', '#2dd4bf', '#facc15', '#f87171', '#4ade80']

const ADJECTIVES = ['Quick', 'Calm', 'Bright', 'Brave', 'Clever', 'Gentle', 'Lucky', 'Swift', 'Witty', 'Bold']
const ANIMALS = ['Otter', 'Falcon', 'Panda', 'Fox', 'Lynx', 'Koala', 'Heron', 'Gecko', 'Tiger', 'Whale']

export interface Identity {
  name: string
  color: string
  colorLight: string
}

const NAME_KEY = 'codehere:name'
const COLOR_KEY = 'codehere:color'

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage can be unavailable (private mode); the identity then lasts for this tab only.
  }
}

export function loadIdentity(): Identity {
  const name = read(NAME_KEY) || `${pick(ADJECTIVES)} ${pick(ANIMALS)}`
  const storedColor = read(COLOR_KEY)
  const color = storedColor && COLORS.includes(storedColor) ? storedColor : pick(COLORS)
  write(NAME_KEY, name)
  write(COLOR_KEY, color)
  return { name, color, colorLight: `${color}40` }
}

export function saveName(name: string): void {
  write(NAME_KEY, name)
}
