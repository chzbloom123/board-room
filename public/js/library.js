import { api } from './api.js'
import { $, el, showView, toast } from './ui.js'
import { openEditor } from './editor.js'
import { openSetup, enterGame } from './game.js'
import { csvFromTopics } from './csv.js'

let allBoards = []

export async function enterLibrary(profile) {
  $('profile-name').textContent = profile.name
  await refreshBoards()
  showView('view-library')
}

async function refreshBoards() {
  allBoards = await api.get('/api/boards')
  $('library-search').hidden = allBoards.length < 5
  renderBoards()
}

function renderBoards() {
  const q = $('library-search').value.trim().toLowerCase()
  const shown = q
    ? allBoards.filter(
        (b) => b.name.toLowerCase().includes(q) || (b.topicNames ?? []).some((t) => t.toLowerCase().includes(q)),
      )
    : allBoards
  const list = $('board-list')
  list.replaceChildren(...shown.map(boardCard))
  $('library-empty').hidden = allBoards.length > 0
  $('library-nomatch').hidden = !(allBoards.length > 0 && shown.length === 0)
}

function relativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.round(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} hr ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`
  return new Date(iso).toLocaleDateString()
}

function boardCard(board, i) {
  const live = Boolean(board.activeSessionId)
  const meta = `${board.topicCount} topic${board.topicCount === 1 ? '' : 's'} · ${board.questionCount} questions · updated ${relativeTime(board.updatedAt)}`
  const topics = board.topicNames ?? []

  const card = el(
    'li',
    { class: `board-card${live ? ' board-card-live' : ''}` },
    el(
      'div',
      { class: 'board-card-head' },
      el('span', { class: 'board-card-name' }, board.name),
      board.hasFinal ? el('span', { class: 'session-chip final-chip', title: 'Has a final round' }, '★ Final') : '',
      live ? el('span', { class: 'session-chip' }, 'Live') : '',
    ),
    el('span', { class: 'board-card-meta' }, meta),
    el(
      'div',
      { class: 'topic-chips' },
      ...topics.slice(0, 6).map((t) => el('span', { class: 'topic-chip', title: t }, t)),
      topics.length > 6 ? el('span', { class: 'topic-chip' }, `+${topics.length - 6} more`) : '',
    ),
    el(
      'div',
      { class: 'board-card-actions' },
      el('button', {
        class: 'btn btn-gold btn-inline',
        onclick: () => (live ? enterGame(board.activeSessionId) : openSetup(board)),
      }, live ? '▶ Resume game' : '▶ Play'),
      el('button', { class: 'btn btn-quiet', onclick: () => editBoard(board.id) }, 'Edit'),
      cardMenu(board),
    ),
  )
  card.style.animationDelay = `${Math.min(i, 12) * 40}ms`
  return card
}

// "More" menu: export, duplicate, delete.
function cardMenu(board) {
  const list = el(
    'div',
    { class: 'card-menu-list' },
    el('button', { onclick: () => exportBoard(board.id) }, '⬇ Export JSON (backup / share)'),
    el('button', { onclick: () => downloadCsv(board.id) }, '⬇ Download CSV (edit in Excel)'),
    el('button', { onclick: () => duplicateBoard(board) }, '⧉ Duplicate'),
    el('button', { class: 'menu-danger', onclick: () => deleteBoard(board) }, '🗑 Delete…'),
  )
  list.hidden = true
  const btn = el('button', { class: 'btn btn-quiet btn-icon', title: 'More actions', ariaLabel: 'More actions' }, '⋯')
  const wrap = el('div', { class: 'card-menu' }, btn, list)
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    const open = list.hidden
    closeAllMenus()
    list.hidden = !open
  })
  list.addEventListener('click', () => (list.hidden = true))
  return wrap
}

function closeAllMenus() {
  for (const m of document.querySelectorAll('.card-menu-list')) m.hidden = true
}

async function editBoard(id) {
  const board = await api.get(`/api/boards/${id}`)
  openEditor(board)
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = el('a', { href: url, download: filename })
  document.body.append(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

const safeName = (name) => name.replaceAll(/[^\w\- ]+/g, '').trim() || 'board'

async function exportBoard(id) {
  const data = await api.get(`/api/boards/${id}/export`)
  downloadBlob(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    `${safeName(data.name)}.board.json`,
  )
}

async function downloadCsv(id) {
  const board = await api.get(`/api/boards/${id}`)
  downloadBlob(new Blob([csvFromTopics(board.topics)], { type: 'text/csv' }), `${safeName(board.name)}.csv`)
}

async function duplicateBoard(board) {
  const data = await api.get(`/api/boards/${board.id}/export`)
  const name = `${board.name} (copy)`
  await api.post('/api/boards/import', { name, topics: data.topics, final: data.final ?? null })
  toast(`Duplicated as "${name}"`)
  await refreshBoards()
}

async function deleteBoard(board) {
  const sessionNote = board.activeSessionId ? ' Its in-progress game will be lost too.' : ''
  if (!confirm(`Delete board "${board.name}"? This cannot be undone.${sessionNote}`)) return
  await api.del(`/api/boards/${board.id}`)
  toast(`Deleted "${board.name}"`)
  await refreshBoards()
}

async function importBoardFile(file) {
  let parsed
  try {
    parsed = JSON.parse(await file.text())
  } catch {
    toast('That file is not valid JSON', 'error')
    return
  }
  const name = parsed.name ?? file.name.replace(/\.board\.json$|\.json$/i, '')
  try {
    await api.post('/api/boards/import', { name, topics: parsed.topics, final: parsed.final ?? null })
    toast(`Imported "${name}"`)
    await refreshBoards()
  } catch (err) {
    const detail = err.data?.errors?.[0]?.message
    toast(detail ? `Import failed: ${detail}` : err.message, 'error')
  }
}

// The bundled sample board: a quick way to see a game run. Saved through
// the normal CSV route so it is validated like anything else.
async function createSampleBoard() {
  const csv = await (await fetch('/samples/sample-board.csv')).text()
  const name = 'Sample board (replace with your own)'
  try {
    await api.post('/api/boards', { name, csv })
    toast(`Added "${name}" — press Play to try it`)
    await refreshBoards()
  } catch (err) {
    toast(err.message, 'error')
  }
}

export function wireLibrary() {
  $('new-board-btn').addEventListener('click', () => openEditor(null))
  $('empty-new-btn').addEventListener('click', () => openEditor(null))
  $('empty-sample-btn').addEventListener('click', createSampleBoard)
  $('import-btn').addEventListener('click', () => $('import-file').click())
  $('import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0]
    e.target.value = ''
    if (file) await importBoardFile(file)
  })
  $('library-search').addEventListener('input', renderBoards)
  document.addEventListener('click', closeAllMenus)
}

export { refreshBoards }
