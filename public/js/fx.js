// Visual effects: confetti, score count-up, floating score badges.
// Presentation only — nothing here touches game state.

const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

// Animate a number from `from` to `to` inside `node` over `ms`.
export function countUp(node, from, to, ms = 650) {
  if (from === to || reduceMotion()) {
    node.textContent = String(to)
    return
  }
  const start = performance.now()
  const step = (now) => {
    const t = Math.min(1, (now - start) / ms)
    const eased = 1 - Math.pow(1 - t, 3)
    node.textContent = String(Math.round(from + (to - from) * eased))
    if (t < 1) requestAnimationFrame(step)
    else node.textContent = String(to)
  }
  requestAnimationFrame(step)
}

// A "+300" / "−300" badge that rises out of `anchor` and fades.
export function floatBadge(anchor, text, kind) {
  const badge = document.createElement('span')
  badge.className = `float-badge float-${kind}`
  badge.textContent = text
  const rect = anchor.getBoundingClientRect()
  badge.style.left = `${rect.left + rect.width / 2}px`
  badge.style.top = `${rect.top}px`
  document.body.append(badge)
  badge.addEventListener('animationend', () => badge.remove())
  setTimeout(() => badge.remove(), 1600)
}

// Confetti burst over the whole viewport. `colors` should be the players'
// colours so the celebration matches the scoreboard.
export function confetti(colors = ['#fca311', '#ffffff', '#60a5fa', '#4ade80'], { duration = 3200, count = 180 } = {}) {
  if (reduceMotion()) return
  const canvas = document.createElement('canvas')
  canvas.className = 'confetti-canvas'
  canvas.width = window.innerWidth
  canvas.height = window.innerHeight
  document.body.append(canvas)
  const g = canvas.getContext('2d')

  const parts = Array.from({ length: count }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * canvas.height * 0.5,
    w: 6 + Math.random() * 8,
    h: 8 + Math.random() * 10,
    vx: (Math.random() - 0.5) * 2.2,
    vy: 2 + Math.random() * 3.5,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.25,
    color: colors[Math.floor(Math.random() * colors.length)],
  }))

  const start = performance.now()
  const frame = (now) => {
    const t = now - start
    g.clearRect(0, 0, canvas.width, canvas.height)
    const fade = t > duration - 600 ? Math.max(0, (duration - t) / 600) : 1
    g.globalAlpha = fade
    for (const p of parts) {
      p.x += p.vx + Math.sin((t + p.y) / 300) * 0.6
      p.y += p.vy
      p.rot += p.vr
      g.save()
      g.translate(p.x, p.y)
      g.rotate(p.rot)
      g.fillStyle = p.color
      g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h)
      g.restore()
    }
    if (t < duration) requestAnimationFrame(frame)
    else canvas.remove()
  }
  requestAnimationFrame(frame)
}

// Briefly flash a node with a CSS class (re-triggerable).
export function flash(node, className, ms = 700) {
  node.classList.remove(className)
  void node.offsetWidth // restart the animation
  node.classList.add(className)
  setTimeout(() => node.classList.remove(className), ms)
}
