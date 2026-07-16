import { api } from './api.js'
import { $, el, showView, toast } from './ui.js'
import { openEditor } from './editor.js'
import { openSetup, enterGame } from './game.js'

export async function enterLibrary(profile) {
  $('profile-name').textContent = profile.name
  await refreshBoards()
  showView('view-library')
}

async function refreshBoards() {
  const boards = await api.get('/api/boards')
  const list = $('board-list')
  list.replaceChildren(...boards.map(boardRow))
  $('library-empty').hidden = boards.length > 0
}

function boardRow(board) {
  const meta = `${board.topicCount} topic${board.topicCount === 1 ? '' : 's'} · ${board.questionCount} questions`
  return el(
    'li',
    { class: 'board-row' },
    el(
      'div',
      { class: 'board-row-info' },
      el('span', { class: 'board-row-name' }, board.name),
      el('span', { class: 'board-row-meta' }, meta),
      board.activeSessionId
        ? el('span', { class: 'session-chip' }, 'Game in progress')
        : '',
    ),
    el(
      'div',
      { class: 'board-row-actions' },
      el('button', {
        class: 'btn btn-gold btn-inline',
        onclick: () =>
          board.activeSessionId ? enterGame(board.activeSessionId) : openSetup(board),
      }, board.activeSessionId ? 'Resume' : 'Play'),
      el('button', { class: 'btn btn-quiet', onclick: () => editBoard(board.id) }, 'Edit'),
      el('button', { class: 'btn btn-quiet', onclick: () => exportBoard(board.id) }, 'Export'),
      el('button', { class: 'btn btn-danger', onclick: () => deleteBoard(board) }, 'Delete'),
    ),
  )
}

async function editBoard(id) {
  const board = await api.get(`/api/boards/${id}`)
  openEditor(board)
}

async function exportBoard(id) {
  const data = await api.get(`/api/boards/${id}/export`)
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = el('a', { href: url, download: `${data.name.replaceAll(/[^\w\- ]+/g, '')}.board.json` })
  document.body.append(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
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
    await api.post('/api/boards/import', { name, topics: parsed.topics })
    toast(`Imported "${name}"`)
    await refreshBoards()
  } catch (err) {
    const detail = err.data?.errors?.[0]?.message
    toast(detail ? `Import failed: ${detail}` : err.message, 'error')
  }
}

export function wireLibrary() {
  $('new-board-btn').addEventListener('click', () => openEditor(null))
  $('import-btn').addEventListener('click', () => $('import-file').click())
  $('import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0]
    e.target.value = ''
    if (file) await importBoardFile(file)
  })
}

export { refreshBoards }
