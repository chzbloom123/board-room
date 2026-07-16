import { api } from './api.js'
import { $, el, showView, toast } from './ui.js'

// Live game (SPEC §6.5–6.6). The server owns all state; after every event
// the client re-renders from the returned session. Nothing is trusted or
// accumulated locally except which players already answered the open
// question wrong (a per-modal UI nicety).

const PALETTE = ['#fca311', '#4ade80', '#60a5fa', '#f472b6', '#a78bfa', '#f87171']

let session = null
let board = null
let openCell = null // { topicIdx, cellIdx } while the modal is up
let wrongThisQuestion = new Set()

// ---------- Player setup ----------

let setupBoard = null

export function openSetup(boardSummary) {
  setupBoard = boardSummary
  $('setup-title').textContent = `New game — ${boardSummary.name}`
  $('setup-error').hidden = true
  const list = $('player-list')
  list.replaceChildren()
  addPlayerRow('')
  addPlayerRow('')
  showView('view-setup')
}

function addPlayerRow(name) {
  const list = $('player-list')
  const idx = list.children.length
  if (idx >= PALETTE.length) {
    toast(`Up to ${PALETTE.length} players`, 'error')
    return
  }
  list.append(
    el(
      'li',
      { class: 'player-row' },
      el('span', { class: 'player-dot', style: `background:${PALETTE[idx]}` }),
      el('input', {
        class: 'player-name-input',
        placeholder: `Player or team ${idx + 1}`,
        value: name,
      }),
      el('button', {
        class: 'btn btn-quiet btn-small',
        onclick: (e) => {
          e.preventDefault()
          e.target.closest('li').remove()
          recolorRows()
        },
      }, 'Remove'),
    ),
  )
}

function recolorRows() {
  Array.from($('player-list').children).forEach((li, i) => {
    li.querySelector('.player-dot').style.background = PALETTE[i]
  })
}

async function startGame() {
  const names = Array.from($('player-list').querySelectorAll('input')).map((i) =>
    i.value.trim(),
  )
  const players = names
    .map((name, i) => ({ name, color: PALETTE[i] }))
    .filter((p) => p.name !== '')
  try {
    const created = await api.post('/api/sessions', {
      boardId: setupBoard.id,
      players,
    })
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
  $('game-board-name').textContent = board.name
  closeModal()
  render()
  showView('view-game')
}

function isUsed(topicIdx, cellIdx) {
  return session.state.usedCells.some(([t, c]) => t === topicIdx && c === cellIdx)
}

function render() {
  renderBoard()
  renderScoreboard()
  $('undo-btn').disabled = session.state.log.length === 0
}

function renderBoard() {
  const grid = $('game-board')
  const topics = board.topics
  grid.style.setProperty('--topic-count', topics.length)
  const maxRows = Math.max(...topics.map((t) => t.cells.length))

  const cells = [
    ...topics.map((t) => el('div', { class: 'topic-header' }, t.name)),
  ]
  for (let row = 0; row < maxRows; row++) {
    for (let ti = 0; ti < topics.length; ti++) {
      const cell = topics[ti].cells[row]
      if (!cell) {
        cells.push(el('div', { class: 'board-cell board-cell-blank' }))
      } else if (isUsed(ti, row)) {
        cells.push(el('div', { class: 'board-cell board-cell-used' }))
      } else {
        cells.push(
          el(
            'button',
            {
              class: 'board-cell board-cell-open',
              onclick: () => openQuestion(ti, row),
            },
            String(cell.points),
          ),
        )
      }
    }
  }
  grid.replaceChildren(...cells)
}

function renderScoreboard() {
  $('scoreboard').replaceChildren(
    ...session.state.players.map((p) =>
      el(
        'div',
        { class: 'score-chip' },
        el('span', { class: 'player-dot', style: `background:${p.color}` }),
        el('span', { class: 'score-name' }, p.name),
        el('span', { class: `score-value${p.score < 0 ? ' score-negative' : ''}` }, String(p.score)),
      ),
    ),
  )
}

// ---------- Question modal ----------

function openQuestion(topicIdx, cellIdx) {
  openCell = { topicIdx, cellIdx }
  wrongThisQuestion = new Set()
  const topic = board.topics[topicIdx]
  const cell = topic.cells[cellIdx]
  $('modal-head').textContent = `${topic.name} · ${cell.points}`
  $('modal-question').textContent = cell.question
  const answer = $('modal-answer')
  answer.textContent = cell.answer
  answer.hidden = true
  $('reveal-btn').hidden = false
  $('judging').hidden = true
  $('noone-btn').hidden = true
  $('question-modal').hidden = false
}

export function revealAnswer() {
  if (!openCell || $('question-modal').hidden) return
  $('modal-answer').hidden = false
  $('reveal-btn').hidden = true
  $('noone-btn').hidden = false
  renderJudging()
  $('judging').hidden = false
}

function renderJudging() {
  $('judging').replaceChildren(
    el('p', { class: 'judging-hint' }, 'Who answered?'),
    ...session.state.players.map((p, idx) =>
      el(
        'div',
        { class: 'judging-row' },
        el('span', { class: 'player-dot', style: `background:${p.color}` }),
        el('span', { class: 'judging-name' }, p.name),
        el('button', {
          class: 'btn btn-correct',
          onclick: () => judge(idx, true),
        }, `Correct +${board.topics[openCell.topicIdx].cells[openCell.cellIdx].points}`),
        el('button', {
          class: 'btn btn-wrong',
          disabled: wrongThisQuestion.has(idx),
          onclick: () => judge(idx, false),
        }, `Wrong −${board.topics[openCell.topicIdx].cells[openCell.cellIdx].points}`),
      ),
    ),
  )
}

async function judge(playerIdx, correct) {
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
  if (correct) {
    closeModal()
  } else {
    wrongThisQuestion.add(playerIdx)
    renderJudging()
  }
  render()
}

async function noOneGotIt() {
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

// ---------- Undo / end ----------

async function undo() {
  try {
    const data = await api.post(`/api/sessions/${session.id}/undo`)
    session = data.session
    toast('Undone')
  } catch (err) {
    toast(err.message, 'error')
  }
  render()
}

async function endGame() {
  if (!confirm('End this game? Scores will be final.')) return
  await api.post(`/api/sessions/${session.id}/end`)
  const standings = [...session.state.players].sort((a, b) => b.score - a.score)
  toast(`Final: ${standings.map((p) => `${p.name} ${p.score}`).join(' · ')}`)
  const { enterLibrary } = await import('./library.js')
  const me = await api.get('/api/me')
  await enterLibrary(me.profile)
}

export function wireGame() {
  $('setup-back-btn').addEventListener('click', backToLibrary)
  $('add-player-btn').addEventListener('click', () => addPlayerRow(''))
  $('start-game-btn').addEventListener('click', startGame)
  $('reveal-btn').addEventListener('click', revealAnswer)
  $('noone-btn').addEventListener('click', noOneGotIt)
  $('modal-cancel-btn').addEventListener('click', () => closeModal())
  $('undo-btn').addEventListener('click', undo)
  $('end-game-btn').addEventListener('click', endGame)
  $('game-back-btn').addEventListener('click', backToLibrary)
}

async function backToLibrary() {
  const { enterLibrary } = await import('./library.js')
  const me = await api.get('/api/me')
  await enterLibrary(me.profile)
}
