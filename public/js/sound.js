// Game-show sound effects, synthesized with the Web Audio API so there are
// no audio assets to ship. The AudioContext is created lazily on the first
// play (always inside a click/keypress) to satisfy autoplay policies.
import { prefs } from './prefs.js'

let ctx = null

function context() {
  if (!ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return null
    ctx = new Ctx()
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  return ctx
}

// One enveloped tone. `type` is an OscillatorNode type.
function tone(ac, { freq, start = 0, duration = 0.15, type = 'sine', gain = 0.18, slideTo = null }) {
  const osc = ac.createOscillator()
  const amp = ac.createGain()
  const t0 = ac.currentTime + start
  osc.type = type
  osc.frequency.setValueAtTime(freq, t0)
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + duration)
  amp.gain.setValueAtTime(0.0001, t0)
  amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.012)
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + duration)
  osc.connect(amp).connect(ac.destination)
  osc.start(t0)
  osc.stop(t0 + duration + 0.02)
}

const EFFECTS = {
  // Cell opened: a quick bright tick.
  open: (ac) => tone(ac, { freq: 880, duration: 0.09, type: 'triangle', gain: 0.12 }),

  // Answer revealed: two-note "ding".
  reveal: (ac) => {
    tone(ac, { freq: 659, duration: 0.18, type: 'triangle', gain: 0.14 })
    tone(ac, { freq: 988, start: 0.1, duration: 0.3, type: 'triangle', gain: 0.14 })
  },

  // Correct: rising major arpeggio.
  correct: (ac) => {
    ;[523, 659, 784, 1047].forEach((f, i) =>
      tone(ac, { freq: f, start: i * 0.07, duration: 0.22, type: 'triangle', gain: 0.16 }),
    )
  },

  // Wrong: the classic low buzzer.
  wrong: (ac) => {
    tone(ac, { freq: 160, duration: 0.42, type: 'sawtooth', gain: 0.12, slideTo: 120 })
    tone(ac, { freq: 164, duration: 0.42, type: 'square', gain: 0.05, slideTo: 122 })
  },

  // Roulette tick while the random picker spins.
  tick: (ac) => tone(ac, { freq: 1200, duration: 0.04, type: 'square', gain: 0.05 }),

  // Undo: short descending blip.
  undo: (ac) => tone(ac, { freq: 600, duration: 0.16, type: 'sine', gain: 0.1, slideTo: 380 }),

  // Final results fanfare.
  fanfare: (ac) => {
    const notes = [523, 523, 523, 659, 784, 659, 784, 1047]
    const starts = [0, 0.12, 0.24, 0.36, 0.52, 0.72, 0.84, 1.0]
    notes.forEach((f, i) =>
      tone(ac, { freq: f, start: starts[i], duration: i === notes.length - 1 ? 0.9 : 0.2, type: 'triangle', gain: 0.16 }),
    )
    // A soft fifth under the last note.
    tone(ac, { freq: 784, start: 1.0, duration: 0.9, type: 'sine', gain: 0.08 })
  },
}

export function play(name) {
  if (!prefs.sound) return
  const ac = context()
  if (!ac) return
  try {
    EFFECTS[name]?.(ac)
  } catch {
    // A failing sound effect must never break the game.
  }
}

export function soundEnabled() {
  return prefs.sound
}

export function setSoundEnabled(on) {
  prefs.sound = on
  if (on) play('open')
}

// ---------- Final-round think music ----------
//
// An original ~30-second piece in the spirit of a game-show "thinking" cue:
// bouncy, staccato, a little cheeky, resolving on a flourish. Deliberately
// not the TV tune — this is a waltz (3/4) in G major with its own melody;
// the TV cue is a 4/4 swing in a different key. Same synthesized voices as
// the rest of the effects so it sits in the same sound world.

const NOTE = {
  D3: 146.83, E3: 164.81, F3s: 185.0, G3: 196.0, A3: 220.0, B3: 246.94, C4: 261.63,
  D4: 293.66, E4: 329.63, F4s: 369.99, G4: 392.0, A4: 440.0, B4: 493.88, C5: 523.25,
  D5: 587.33, E5: 659.25, F5s: 739.99, G5: 783.99, A5: 880.0, B5: 987.77,
}

const BPM = 138
const BEAT = 60 / BPM // seconds
const BAR = BEAT * 3

// Melody as bars of [note, beats]. "R" is a rest.
const MELODY = [
  // A — the question is posed
  [['G4', 1], ['B4', 1], ['D5', 1]],
  [['B4', 2], ['G4', 1]],
  [['A4', 1], ['C5', 1], ['E5', 1]],
  [['C5', 2], ['A4', 1]],
  [['G4', 1], ['B4', 1], ['D5', 1]],
  [['G5', 2], ['F5s', 1]],
  [['E5', 1], ['D5', 1], ['C5', 1]],
  [['B4', 3]],
  // A' — the same idea, climbing higher: the clock is ticking
  [['G4', 1], ['B4', 1], ['D5', 1]],
  [['B4', 2], ['G4', 1]],
  [['A4', 1], ['C5', 1], ['E5', 1]],
  [['C5', 2], ['A4', 1]],
  [['D5', 1], ['E5', 1], ['F5s', 1]],
  [['G5', 1], ['A5', 1], ['B5', 1]],
  [['A5', 1], ['G5', 1], ['F5s', 1]],
  [['G5', 3]],
  // B — a nudge: hurry up
  [['D5', 0.5], ['D5', 0.5], ['E5', 1], ['F5s', 1]],
  [['G5', 2], ['D5', 1]],
  [['E5', 0.5], ['E5', 0.5], ['F5s', 1], ['G5', 1]],
  [['A5', 2], ['R', 1]],
  // Flourish — time's up
  [['B5', 0.5], ['A5', 0.5], ['G5', 0.5], ['F5s', 0.5], ['E5', 0.5], ['D5', 0.5]],
  [['G5', 1.5], ['B4', 0.5], ['G4', 1]],
]

// Bass root per bar (oom-pah accompaniment follows this).
const BASS = [
  'G3', 'G3', 'A3', 'A3', 'G3', 'G3', 'C4', 'G3',
  'G3', 'G3', 'A3', 'A3', 'D3', 'G3', 'D3', 'G3',
  'G3', 'G3', 'C4', 'D3',
  'D3', 'G3',
]

// Chord tones (above the root) for the "pah" on beats 2 and 3.
const CHORD = {
  G3: ['B3', 'D4'], A3: ['C4', 'E4'], C4: ['E4', 'G4'], D3: ['F3s', 'A3'],
}

export const THINK_MUSIC_SECONDS = MELODY.length * BAR + 0.8

let thinkMusicNodes = []

function schedule(ac, { freq, at, duration, type, gain }) {
  const osc = ac.createOscillator()
  const amp = ac.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, at)
  amp.gain.setValueAtTime(0.0001, at)
  amp.gain.exponentialRampToValueAtTime(gain, at + 0.015)
  amp.gain.setValueAtTime(gain, at + duration * 0.6)
  amp.gain.exponentialRampToValueAtTime(0.0001, at + duration)
  osc.connect(amp).connect(ac.destination)
  osc.start(at)
  osc.stop(at + duration + 0.02)
  thinkMusicNodes.push(osc)
}

// Starts the piece; returns its length in seconds (also when muted, so the
// on-screen progress bar runs either way).
export function playThinkMusic() {
  stopThinkMusic()
  if (!prefs.sound) return THINK_MUSIC_SECONDS
  const ac = context()
  if (!ac) return THINK_MUSIC_SECONDS
  const t0 = ac.currentTime + 0.05

  MELODY.forEach((bar, b) => {
    const barStart = t0 + b * BAR
    // Melody: staccato triangle, slightly brighter in the flourish.
    let beat = 0
    for (const [name, beats] of bar) {
      if (name !== 'R') {
        schedule(ac, {
          freq: NOTE[name],
          at: barStart + beat * BEAT,
          duration: Math.min(beats * BEAT * 0.8, beats * BEAT - 0.03),
          type: 'triangle',
          gain: b >= 20 ? 0.2 : 0.16,
        })
      }
      beat += beats
    }
    // Oom (beat 1): soft sine bass.
    const root = BASS[b]
    schedule(ac, { freq: NOTE[root], at: barStart, duration: BEAT * 0.9, type: 'sine', gain: 0.14 })
    // Pah-pah (beats 2 and 3): quiet chord stabs.
    for (const k of [1, 2]) {
      for (const tone of CHORD[root] ?? []) {
        schedule(ac, { freq: NOTE[tone], at: barStart + k * BEAT, duration: BEAT * 0.35, type: 'sine', gain: 0.035 })
      }
    }
  })
  // Final chord under the last note.
  const end = t0 + MELODY.length * BAR - BEAT
  for (const tone of ['G3', 'B3', 'D4']) {
    schedule(ac, { freq: NOTE[tone], at: end, duration: 1.1, type: 'sine', gain: 0.07 })
  }
  return THINK_MUSIC_SECONDS
}

export function stopThinkMusic() {
  for (const osc of thinkMusicNodes) {
    try {
      osc.stop()
    } catch {
      // already stopped
    }
  }
  thinkMusicNodes = []
}
