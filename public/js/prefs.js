// Per-browser instructor preferences (theme, sound, last-used teams).
// Pure convenience: nothing here is game state — the server owns that —
// so losing localStorage never loses a game.

const PREFIX = 'boardroom.'

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw === null ? fallback : JSON.parse(raw)
  } catch {
    return fallback
  }
}

function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // Private mode / blocked storage: preferences simply don't persist.
  }
}

export const THEMES = [
  { id: 'classic', label: 'Classic navy' },
  { id: 'emerald', label: 'Emerald' },
  { id: 'crimson', label: 'Crimson' },
  { id: 'midnight', label: 'Midnight' },
]

export const prefs = {
  get theme() {
    const t = read('theme', 'classic')
    return THEMES.some((x) => x.id === t) ? t : 'classic'
  },
  set theme(id) {
    write('theme', id)
    applyTheme(id)
  },

  get sound() {
    return read('sound', true)
  },
  set sound(on) {
    write('sound', Boolean(on))
  },

  lastPlayers(boardId) {
    return read(`players.${boardId}`, null)
  },
  rememberPlayers(boardId, players) {
    write(`players.${boardId}`, players.map((p) => ({ name: p.name, color: p.color })))
  },
}

export function applyTheme(id = prefs.theme) {
  document.documentElement.dataset.theme = id
}
