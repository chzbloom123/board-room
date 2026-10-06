import { api } from './api.js'
import { $, el, showView, toast } from './ui.js'
import { prefs } from './prefs.js'
import { play, soundEnabled, setSoundEnabled, playThinkMusic, stopThinkMusic } from './sound.js'
import { countUp, floatBadge, confetti, flash } from './fx.js'

// Live game (SPEC §6.5–6.6). The server owns all state; after every event
// the client re-renders from the returned session. Nothing is trusted or
// accumulated locally except which players already answered the open
// question wrong (a per-modal UI nicety) and presentation bookkeeping
// (previous scores for animation, whether results were shown).

const PALETTE = ['#fca311', '#4ade80', '#60a5fa', '#f472b6', '#a78bfa', '#f87171', '#34d399', '#fb923c']
const MAX_PLAYERS = 6

const TEAM_NAMES = [
  'The Turbines', 'Night Owls', 'Boiler Room', 'Full Steam', 'High Voltage',
  'Red Hats', 'The Regulators', 'Ground Crew', 'Pressure Cookers', 'Lockout Legends',
  'Team Torque', 'The Gauges', 'Kilowatts', 'The Foremen', 'Blue Collars',
  'Hard Hats', 'The Valves', 'Day Shift', 'Swing Shift', 'The Inspectors',
]

let session = null
let board = null
let openCell = null // { topicIdx, cellIdx } while the modal is up
let wrongThisQuestion = new Set()
let prevScores = null // for count-up animation between renders
let completionShownFor = null // session id whose "board complete" results were auto-shown
let finalDoneShownFor = null // session id whose final-round results were auto-shown
let finalRevealed = false // answer shown in the final-round overlay (per open)
let musicTimer = null
let rouletteRunning = false

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- Player setup ----------

let setupBoard = null

export function openSetup(boardSummary) {
  setupBoard = boardSummary
  $('setup-title').textContent = `New game — ${boardSummary.name}`
  $('setup-error').hidden = true
  const list = $('player-list')
  list.replaceChildren()

  const last = prefs.lastPlayers(boardSummary.id)
  const lastBtn = $('setup-last-btn')
  if (last && last.length > 0) {
    lastBtn.textContent = `↻ Use last time's teams: ${last.map((p) => p.name).join(', ')}`
    lastBtn.hidden = false
    lastBtn.onclick = () => {
      list.replaceChildren()
      for (const p of last.slice(0, MAX_PLAYERS)) addPlayerRow(p.name, p.color)
    }
  } else {
    lastBtn.hidden = true
  }

  addPlayerRow('')
  addPlayerRow('')
  showView('view-setup')
}

function usedColors() {
  return new Set(Array.from($('player-list').querySelectorAll('.player-dot-btn')).map((b) => b.dataset.color))
}

function nextFreeColor() {
  const used = usedColors()
  return PALETTE.find((c) => !used.has(c)) ?? PALETTE[used.size % PALETTE.length]
}

function addPlayerRow(name, color) {
  const list = $('player-list')
  const idx = list.children.length
  if (idx >= MAX_PLAYERS) {
    toast(`Up to ${MAX_PLAYERS} players`, 'error')
    return
  }
  const dot = el('button', {
    class: 'player-dot-btn',
    type: 'button',
    title: 'Change colour',
    dataset: { color: color ?? nextFreeColor() },
  })
  dot.style.background = dot.dataset.color
  dot.addEventListener('click', () => {
    // Cycle to the next colour nobody else is using.
    const used = usedColors()
    used.delete(dot.dataset.color)
    const start = PALETTE.indexOf(dot.dataset.color)
    for (let k = 1; k <= PALETTE.length; k++) {
      const candidate = PALETTE[(start + k) % PALETTE.length]
      if (!used.has(candidate)) {
        dot.dataset.color = candidate
        dot.style.background = candidate
        break
      }
    }
  })
  const input = el('input', {
    class: 'player-name-input',
    placeholder: `Player or team ${idx + 1}`,
    value: name,
    maxLength: 40,
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      startGame()
    }
  })
  list.append(
    el(
      'li',
      { class: 'player-row' },
      dot,
      input,
      el('button', {
        class: 'btn btn-quiet btn-small',
        type: 'button',
        onclick: (e) => e.target.closest('li').remove(),
      }, 'Remove'),
    ),
  )
  if (name === '' && idx > 0) input.focus()
}

function suggestNames() {
  const inputs = Array.from($('player-list').querySelectorAll('input'))
  if (inputs.length === 0) addPlayerRow('')
  const taken = new Set(inputs.map((i) => i.value.trim()))
  const pool = TEAM_NAMES.filter((n) => !taken.has(n)).sort(() => Math.random() - 0.5)
  for (const input of $('player-list').querySelectorAll('input')) {
    if (input.value.trim() === '' && pool.length) input.value = pool.pop()
  }
}

function readPlayers() {
  return Array.from($('player-list').children)
    .map((li) => ({
      name: li.querySelector('input').value.trim(),
      color: li.querySelector('.player-dot-btn').dataset.color,
    }))
    .filter((p) => p.name !== '')
}

async function startGame() {
  const players = readPlayers()
  try {
    const created = await api.post('/api/sessions', { boardId: setupBoard.id, players })
    prefs.rememberPlayers(setupBoard.id, players)
    await enterGame(created.session.id)
  } catch (err) {
    const errEl = $('setup-error')
    errEl.textContent = err.message
    errEl.hidden = false
  }
}

// ---------- Game ----------

export async function enterGame(sessionId) {
  const data = await api.get(`/api/sessions/${sessionId}`)
  session = data.session
  board = data.board
  prevScores = null
  $('game-board-name').textContent = board.name
  closeModal()
  closeResults()
  closeHelp()
  closeFinal()
  render()
  showView('view-game')
  // Intro cascade: cells pop in column by column.
  const grid = $('game-board')
  grid.classList.add('board-enter')
  setTimeout(() => grid.classList.remove('board-enter'), 2000)
}

function isUsed(topicIdx, cellIdx) {
  return session.state.usedCells.some(([t, c]) => t === topicIdx && c === cellIdx)
}

function totalCells() {
  return board.topics.reduce((n, t) => n + t.cells.length, 0)
}

function remainingCells() {
  return totalCells() - session.state.usedCells.length
}

// The player "in control" — whoever answered the last question correctly.
function controllingPlayer() {
  for (let i = session.state.log.length - 1; i >= 0; i--) {
    const e = session.state.log[i]
    if (e.correct === true && e.playerIdx !== null) return e.playerIdx
  }
  return null
}

function render() {
  renderBoard()
  renderScoreboard()
  renderProgress()
  $('undo-btn').disabled = session.state.log.length === 0
  $('random-btn').disabled = remainingCells() === 0
  $('final-btn').hidden = !finalAvailable()
  if (!$('final-modal').hidden && finalState()) renderFinalPlay()

  if (session.status !== 'active') return
  if (finalAvailable() && finalDone()) {
    if (finalDoneShownFor !== session.id) {
      finalDoneShownFor = session.id
      setTimeout(() => showResults('Final round complete!'), 900)
    }
  } else if (remainingCells() === 0 && completionShownFor !== session.id && !finalState()) {
    completionShownFor = session.id
    setTimeout(() => showResults('Board complete!'), 700)
  }
}

// ---------- Final round ----------
// Board-level: board.final = { category, question, answer } (optional).
// Session-level: state.final = { wagers, judged } once wagers are locked.

function finalAvailable() {
  return Boolean(board?.final)
}

function finalState() {
  return session?.state?.final ?? null
}

function finalDone() {
  const f = finalState()
  return Boolean(f) && f.judged.length === session.state.players.length
}

function openFinal() {
  if (!finalAvailable()) return
  closeModal()
  closeResults()
  $('final-category').textContent = board.final.category
  $('final-error').hidden = true
  finalRevealed = false
  if (finalState()) {
    $('final-wagers').hidden = true
    $('final-play').hidden = false
    renderFinalPlay()
  } else {
    renderWagerRows()
    $('final-play').hidden = true
    $('final-wagers').hidden = false
  }
  $('final-modal').hidden = false
  play('open')
}

function renderWagerRows() {
  $('final-wager-rows').replaceChildren(
    ...session.state.players.map((p, i) => {
      const max = Math.max(0, p.score)
      const input = el('input', {
        class: 'wager-input',
        type: 'number',
        min: 0,
        max,
        step: 1,
        value: 0,
        disabled: max === 0,
        dataset: { idx: String(i) },
        ariaLabel: `${p.name} wager`,
      })
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          lockWagers()
        }
      })
      const row = el(
        'div',
        { class: 'wager-row' },
        el('span', { class: 'wager-name' }, p.name),
        el('span', { class: 'wager-max' }, max === 0 ? `score ${p.score} — can't wager` : `score ${p.score} · up to ${max}`),
        input,
      )
      row.style.setProperty('--player-color', p.color)
      return row
    }),
  )
  $('final-wager-rows').querySelector('input:not(:disabled)')?.focus()
}

async function lockWagers() {
  const errEl = $('final-error')
  errEl.hidden = true
  const wagers = session.state.players.map((p, i) => {
    const input = $('final-wager-rows').querySelector(`input[data-idx="${i}"]`)
    return input.disabled ? 0 : Number(input.value)
  })
  for (let i = 0; i < wagers.length; i++) {
    const max = Math.max(0, session.state.players[i].score)
    if (!Number.isInteger(wagers[i]) || wagers[i] < 0 || wagers[i] > max) {
      errEl.textContent = `${session.state.players[i].name} can wager a whole number between 0 and ${max}`
      errEl.hidden = false
      return
    }
  }
  try {
    const data = await api.post(`/api/sessions/${session.id}/final/start`, { wagers })
    session = data.session
  } catch (err) {
    errEl.textContent = err.message
    errEl.hidden = false
    return
  }
  $('final-wagers').hidden = true
  $('final-play').hidden = false
  finalRevealed = false
  renderFinalPlay()
  render()
  startThinkMusic()
}

function renderFinalPlay() {
  const f = finalState()
  if (!f) return
  $('final-question').textContent = board.final.question
  const answer = $('final-answer')
  answer.textContent = board.final.answer
  const showJudging = finalRevealed || f.judged.length > 0
  answer.hidden = !showJudging
  $('final-reveal-btn').hidden = showJudging
  $('final-music-btn').hidden = showJudging
  $('final-judging').hidden = !showJudging
  $('final-results-btn').hidden = !finalDone()
  if (showJudging) renderFinalJudging()
}

function renderFinalJudging() {
  const f = finalState()
  $('final-judging').replaceChildren(
    el('p', { class: 'judging-hint' }, 'Judge each team: number = correct, Shift+number = wrong'),
    ...session.state.players.map((p, idx) => {
      const wager = f.wagers[idx]
      const judged = f.judged.includes(idx)
      const verdict = judged ? session.state.log.findLast((e) => e.final && e.playerIdx === idx) : null
      const row = el(
        'div',
        { class: `judging-row${judged ? ' judging-row-judged' : ''}` },
        el('span', { class: 'judging-key' }, String(idx + 1)),
        el('span', { class: 'judging-name' }, p.name),
        el('span', { class: 'wager-chip' }, `wagered ${wager}`),
        ...(judged
          ? [el('span', { class: `judge-result ${verdict?.correct ? 'up' : 'down'}` }, verdict?.correct ? `✓ +${wager}` : `✗ −${wager}`)]
          : [
              el('button', { class: 'btn btn-correct', onclick: () => judgeFinal(idx, true) }, `Correct +${wager}`),
              el('button', { class: 'btn btn-wrong', onclick: () => judgeFinal(idx, false) }, `Wrong −${wager}`),
            ]),
      )
      row.style.setProperty('--player-color', p.color)
      return row
    }),
  )
}

function revealFinal() {
  if ($('final-modal').hidden || !finalState() || finalRevealed) return
  finalRevealed = true
  stopMusicBar()
  renderFinalPlay()
  play('reveal')
}

async function judgeFinal(playerIdx, correct) {
  const f = finalState()
  if (!f || f.judged.includes(playerIdx)) return
  try {
    const data = await api.post(`/api/sessions/${session.id}/events`, { final: true, playerIdx, correct })
    session = data.session
  } catch (err) {
    toast(err.message, 'error')
    return
  }
  play(correct ? 'correct' : 'wrong')
  render()
}

function startThinkMusic() {
  const seconds = playThinkMusic()
  const bar = $('final-music')
  const fill = $('final-music-fill')
  bar.hidden = false
  bar.classList.remove('music-done')
  $('final-music-label').textContent = '♪ think music'
  fill.style.transition = 'none'
  fill.style.width = '0%'
  void fill.offsetWidth
  fill.style.transition = `width ${seconds}s linear`
  fill.style.width = '100%'
  clearTimeout(musicTimer)
  musicTimer = setTimeout(() => {
    bar.classList.add('music-done')
    $('final-music-label').textContent = "Time's up — reveal the answer"
  }, seconds * 1000)
}

function stopMusicBar() {
  stopThinkMusic()
  clearTimeout(musicTimer)
  $('final-music').hidden = true
}

function closeFinal() {
  stopMusicBar()
  $('final-modal').hidden = true
}

function isFinalOpen() {
  return !$('final-modal').hidden
}

function renderBoard() {
  const grid = $('game-board')
  const topics = board.topics
  grid.style.setProperty('--topic-count', topics.length)
  const maxRows = Math.max(...topics.map((t) => t.cells.length))

  const cells = topics.map((t, ti) => {
    const h = el('div', { class: 'topic-header' }, t.name)
    h.style.setProperty('--i', ti * (maxRows + 1))
    return h
  })
  for (let row = 0; row < maxRows; row++) {
    for (let ti = 0; ti < topics.length; ti++) {
      const cell = topics[ti].cells[row]
      let node
      if (!cell) {
        node = el('div', { class: 'board-cell board-cell-blank' })
      } else if (isUsed(ti, row)) {
        node = el('div', { class: 'board-cell board-cell-used' })
      } else {
        node = el(
          'button',
          {
            class: 'board-cell board-cell-open',
            dataset: { ti: String(ti), ci: String(row) },
            onclick: (e) => openQuestion(ti, row, e.currentTarget),
          },
          String(cell.points),
        )
      }
      node.style.setProperty('--i', ti * (maxRows + 1) + row + 1)
      cells.push(node)
    }
  }
  grid.replaceChildren(...cells)
}

function renderScoreboard() {
  const players = session.state.players
  const scores = players.map((p) => p.score)
  const max = Math.max(...scores)
  const min = Math.min(...scores)
  const control = players.length > 1 ? controllingPlayer() : null
  const animate = prevScores !== null && prevScores.length === players.length

  const chips = players.map((p, i) => {
    const value = el('span', { class: `score-value${p.score < 0 ? ' score-negative' : ''}` }, String(p.score))
    const chip = el(
      'div',
      { class: 'score-chip' },
      el('span', { class: 'score-name' }, p.name),
      value,
    )
    chip.style.setProperty('--player-color', p.color)
    if (max > min && p.score === max) {
      chip.classList.add('score-leader')
      chip.prepend(el('span', { class: 'score-crown', title: 'In the lead' }, '👑'))
    }
    if (control === i) chip.append(el('span', { class: 'score-control' }, 'picks next'))
    return { chip, value, from: animate ? prevScores[i] : p.score, to: p.score }
  })

  $('scoreboard').replaceChildren(...chips.map((c) => c.chip))
  for (const c of chips) {
    if (c.from === c.to) continue
    countUp(c.value, c.from, c.to)
    const delta = c.to - c.from
    flash(c.chip, delta > 0 ? 'score-flash-up' : 'score-flash-down')
    floatBadge(c.value, `${delta > 0 ? '+' : '−'}${Math.abs(delta)}`, delta > 0 ? 'up' : 'down')
  }
  prevScores = scores
}

function renderProgress() {
  const total = totalCells()
  const left = remainingCells()
  $('game-remaining').textContent = left === 0 ? 'Board complete' : `${left} of ${total} left`
  $('game-progress-bar').style.width = `${total === 0 ? 0 : ((total - left) / total) * 100}%`
}

// ---------- Question modal ----------

function openQuestion(topicIdx, cellIdx, sourceEl) {
  openCell = { topicIdx, cellIdx }
  wrongThisQuestion = new Set()
  const topic = board.topics[topicIdx]
  const cell = topic.cells[cellIdx]
  $('modal-topic').textContent = topic.name
  $('modal-points').textContent = String(cell.points)
  $('modal-question').textContent = cell.question
  const answer = $('modal-answer')
  answer.textContent = cell.answer
  answer.hidden = true
  $('reveal-btn').hidden = false
  $('judging').hidden = true
  $('noone-btn').hidden = true
  $('question-modal').hidden = false

  // Zoom the card out of the cell that was clicked.
  const card = $('modal-card')
  card.classList.remove('zoom-from-cell')
  if (sourceEl) {
    const r = sourceEl.getBoundingClientRect()
    const c = card.getBoundingClientRect()
    card.style.transformOrigin = `${r.left + r.width / 2 - c.left}px ${r.top + r.height / 2 - c.top}px`
    void card.offsetWidth
    card.classList.add('zoom-from-cell')
  }
  play('open')
  $('reveal-btn').focus({ preventScroll: true })
}

export function revealAnswer() {
  if (!openCell || $('question-modal').hidden) return
  if (!$('modal-answer').hidden) return
  $('modal-answer').hidden = false
  $('reveal-btn').hidden = true
  $('noone-btn').hidden = false
  renderJudging()
  $('judging').hidden = false
  play('reveal')
}

function judgingOpen() {
  return isModalOpen() && !$('judging').hidden
}

function renderJudging() {
  const points = board.topics[openCell.topicIdx].cells[openCell.cellIdx].points
  $('judging').replaceChildren(
    el('p', { class: 'judging-hint' }, 'Who answered? Press a number to award, Shift+number to deduct'),
    ...session.state.players.map((p, idx) => {
      const row = el(
        'div',
        { class: `judging-row${wrongThisQuestion.has(idx) ? ' judging-row-wrong' : ''}` },
        el('span', { class: 'judging-key' }, String(idx + 1)),
        el('span', { class: 'judging-name' }, p.name),
        el('button', { class: 'btn btn-correct', onclick: () => judge(idx, true) }, `Correct +${points}`),
        el('button', {
          class: 'btn btn-wrong',
          disabled: wrongThisQuestion.has(idx),
          onclick: () => judge(idx, false),
        }, wrongThisQuestion.has(idx) ? 'Missed it' : `Wrong −${points}`),
      )
      row.style.setProperty('--player-color', p.color)
      return row
    }),
  )
}

async function judge(playerIdx, correct) {
  if (!openCell) return
  if (!correct && wrongThisQuestion.has(playerIdx)) return
  const { topicIdx, cellIdx } = openCell
  try {
    const data = await api.post(`/api/sessions/${session.id}/events`, {
      playerIdx,
      correct,
      topicIdx,
      cellIdx,
      closesCell: correct, // a correct answer ends the question
    })
    session = data.session
  } catch (err) {
    toast(err.message, 'error')
    return
  }
  play(correct ? 'correct' : 'wrong')
  if (correct) {
    closeModal()
  } else {
    wrongThisQuestion.add(playerIdx)
    renderJudging()
  }
  render()
}

async function noOneGotIt() {
  if (!openCell) return
  const { topicIdx, cellIdx } = openCell
  try {
    const data = await api.post(`/api/sessions/${session.id}/events`, {
      topicIdx,
      cellIdx,
      closesCell: true,
    })
    session = data.session
  } catch (err) {
    toast(err.message, 'error')
    return
  }
  closeModal()
  render()
}

export function closeModal() {
  openCell = null
  $('question-modal').hidden = true
}

export function isModalOpen() {
  return !$('question-modal').hidden
}

// ---------- Random pick (roulette) ----------

async function randomPick() {
  if (rouletteRunning || isModalOpen() || anyOverlayOpen()) return
  const open = Array.from($('game-board').querySelectorAll('.board-cell-open'))
  if (open.length === 0) return
  rouletteRunning = true
  $('random-btn').disabled = true
  const chosen = open[Math.floor(Math.random() * open.length)]
  let current = null
  let delay = 55
  const hops = Math.min(16, open.length * 3)
  for (let i = 0; i < hops; i++) {
    let next = open[Math.floor(Math.random() * open.length)]
    if (open.length > 1 && next === current) next = open[(open.indexOf(next) + 1) % open.length]
    current?.classList.remove('cell-roulette')
    current = next
    current.classList.add('cell-roulette')
    play('tick')
    await sleep(delay)
    delay = Math.min(260, delay * 1.17)
  }
  current?.classList.remove('cell-roulette')
  chosen.classList.add('cell-roulette', 'cell-chosen')
  play('reveal')
  await sleep(750)
  chosen.classList.remove('cell-roulette', 'cell-chosen')
  rouletteRunning = false
  $('random-btn').disabled = false
  if (!$('view-game').hidden && chosen.isConnected) chosen.click()
}

// ---------- Undo / results / end ----------

async function undo() {
  if ($('undo-btn').disabled) return
  try {
    const data = await api.post(`/api/sessions/${session.id}/undo`)
    session = data.session
    play('undo')
    toast('Undone')
  } catch (err) {
    toast(err.message, 'error')
  }
  render()
}

function standings() {
  return session.state.players
    .map((p, idx) => ({ ...p, idx }))
    .sort((a, b) => b.score - a.score)
}

function showResults(kicker = 'Final standings') {
  closeModal()
  closeFinal()
  $('results-final-btn').hidden = !(finalAvailable() && !finalDone())
  $('results-final-btn').textContent = finalState() ? '★ Continue the final round' : '★ Play the final round'
  const ranked = standings()
  const top = ranked[0]
  const winners = ranked.filter((p) => p.score === top.score)
  $('results-kicker').textContent = kicker
  $('results-title').textContent =
    ranked.length === 1
      ? `${top.name}: ${top.score}`
      : winners.length > 1
        ? `It's a tie: ${winners.map((p) => p.name).join(' & ')}`
        : `${top.name} wins!`

  // Podium: up to three bars, heights relative to the best score.
  const podiumOrder = [ranked[1], ranked[0], ranked[2]].filter(Boolean)
  const best = Math.max(1, ...ranked.map((p) => p.score))
  const medals = ['🥇', '🥈', '🥉']
  $('podium').replaceChildren(
    ...podiumOrder.map((p) => {
      const rank = ranked.indexOf(p)
      const pct = p.score <= 0 ? 12 : Math.max(18, (p.score / best) * 100)
      const col = el(
        'div',
        { class: 'podium-col' },
        el('div', { class: 'podium-name', title: p.name }, p.name),
        el('div', { class: `podium-score${p.score < 0 ? ' score-negative' : ''}` }, String(p.score)),
        el('div', { class: 'podium-bar', style: `height:${pct}%` }, medals[rank] ?? ''),
      )
      col.style.setProperty('--player-color', p.color)
      return col
    }),
  )
  $('results-list').replaceChildren(
    ...ranked.map((p, i) =>
      el(
        'li',
        {},
        el('span', { class: 'rank' }, `${i + 1}.`),
        el('span', { class: 'rname' }, p.name),
        el('span', { class: `rscore${p.score < 0 ? ' score-negative' : ''}` }, String(p.score)),
      ),
    ),
  )
  $('results-modal').hidden = false
  play('fanfare')
  confetti(winners.map((p) => p.color).concat(['#ffffff', getComputedStyle(document.documentElement).getPropertyValue('--gold').trim() || '#fca311']))
}

function closeResults() {
  $('results-modal').hidden = true
}

async function finishGame() {
  await api.post(`/api/sessions/${session.id}/end`)
  closeResults()
  closeFinal()
  const summary = standings().map((p) => `${p.name} ${p.score}`).join(' · ')
  toast(`Final: ${summary}`)
  await backToLibrary()
}

async function rematch() {
  if (!confirm('End this game and start a new one with the same teams?')) return
  const players = session.state.players.map((p) => ({ name: p.name, color: p.color }))
  const boardId = session.boardId
  try {
    await api.post(`/api/sessions/${session.id}/end`)
    const created = await api.post('/api/sessions', { boardId, players })
    closeResults()
    await enterGame(created.session.id)
    toast('Rematch! Scores reset.')
  } catch (err) {
    toast(err.message, 'error')
  }
}

// ---------- Help / settings ----------

function openHelp() {
  $('help-modal').hidden = false
}
function closeHelp() {
  $('help-modal').hidden = true
}
function anyOverlayOpen() {
  return !$('results-modal').hidden || !$('help-modal').hidden || isFinalOpen()
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen()
  else document.documentElement.requestFullscreen?.()
}

function renderSoundButton() {
  const on = soundEnabled()
  $('sound-btn').textContent = on ? '🔊' : '🔇'
  $('sound-btn').title = on ? 'Sound on — click to mute (M)' : 'Sound off — click to unmute (M)'
}

function toggleSound() {
  setSoundEnabled(!soundEnabled())
  renderSoundButton()
}

// Presentation-mode shortcuts (SPEC §6.7 plus instructor conveniences).
// Never fire while typing in an input, and only while the game view is on
// screen.
function handleShortcut(e) {
  const target = e.target
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  ) {
    return
  }
  if ($('view-game').hidden) return
  if (e.ctrlKey || e.metaKey || e.altKey) return

  const key = e.key

  if (key === 'Escape') {
    if (!$('help-modal').hidden) closeHelp()
    else if (!$('results-modal').hidden) closeResults()
    else if (isFinalOpen()) closeFinal()
    else if (isModalOpen()) closeModal()
    return
  }
  if (key === '?') {
    e.preventDefault()
    $('help-modal').hidden ? openHelp() : closeHelp()
    return
  }
  if (key === 'u' || key === 'U') {
    undo()
    return
  }
  if (isFinalOpen() && finalState()) {
    if (key === ' ') {
      e.preventDefault()
      revealFinal()
    } else if (/^Digit[1-6]$/.test(e.code) && !$('final-judging').hidden) {
      const idx = Number(e.code.slice(5)) - 1
      if (session.state.players[idx]) {
        e.preventDefault()
        judgeFinal(idx, !e.shiftKey)
      }
    }
    return
  }
  if (anyOverlayOpen()) return

  if (key === ' ') {
    e.preventDefault() // keep Space from scrolling or re-clicking buttons
    if (isModalOpen()) revealAnswer()
  } else if (key === 'f' || key === 'F') {
    e.preventDefault()
    toggleFullscreen()
  } else if (key === 'm' || key === 'M') {
    toggleSound()
  } else if (key === 'r' || key === 'R') {
    randomPick()
  } else if ((key === 'n' || key === 'N') && judgingOpen()) {
    noOneGotIt()
  } else if (/^Digit[1-6]$/.test(e.code) && judgingOpen()) {
    const idx = Number(e.code.slice(5)) - 1
    if (session.state.players[idx]) {
      e.preventDefault()
      judge(idx, !e.shiftKey)
    }
  }
}

export function wireGame() {
  document.addEventListener('keydown', handleShortcut)
  $('setup-back-btn').addEventListener('click', backToLibrary)
  $('add-player-btn').addEventListener('click', () => addPlayerRow(''))
  $('suggest-names-btn').addEventListener('click', suggestNames)
  $('start-game-btn').addEventListener('click', startGame)
  $('reveal-btn').addEventListener('click', revealAnswer)
  $('noone-btn').addEventListener('click', noOneGotIt)
  $('modal-cancel-btn').addEventListener('click', () => closeModal())
  $('undo-btn').addEventListener('click', undo)
  $('random-btn').addEventListener('click', randomPick)
  $('end-game-btn').addEventListener('click', () => showResults(remainingCells() === 0 ? 'Board complete!' : 'Standings so far'))
  $('results-close-btn').addEventListener('click', closeResults)
  $('results-rematch-btn').addEventListener('click', rematch)
  $('results-finish-btn').addEventListener('click', finishGame)
  $('results-final-btn').addEventListener('click', openFinal)
  $('final-btn').addEventListener('click', openFinal)
  $('final-cancel-btn').addEventListener('click', closeFinal)
  $('final-close-btn').addEventListener('click', closeFinal)
  $('final-lock-btn').addEventListener('click', lockWagers)
  $('final-reveal-btn').addEventListener('click', revealFinal)
  $('final-music-btn').addEventListener('click', startThinkMusic)
  $('final-results-btn').addEventListener('click', () => showResults('Final round complete!'))
  $('help-btn').addEventListener('click', openHelp)
  $('help-close-btn').addEventListener('click', closeHelp)
  $('fullscreen-btn').addEventListener('click', toggleFullscreen)
  $('sound-btn').addEventListener('click', toggleSound)
  $('game-back-btn').addEventListener('click', backToLibrary)
  // Clicking the dark backdrop closes the overlay, same as Esc.
  for (const id of ['question-modal', 'results-modal', 'help-modal', 'final-modal']) {
    $(id).addEventListener('click', (e) => {
      if (e.target !== e.currentTarget) return
      if (id === 'question-modal') closeModal()
      else if (id === 'results-modal') closeResults()
      else if (id === 'final-modal') closeFinal()
      else closeHelp()
    })
  }
  renderSoundButton()
}

async function backToLibrary() {
  const { enterLibrary } = await import('./library.js')
  const me = await api.get('/api/me')
  await enterLibrary(me.profile)
}
