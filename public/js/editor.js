import { api } from './api.js'
import { $, el, showView, toast } from './ui.js'
// The same parser the server validates with — one pipeline, two callers.
import { boardFromCsv, csvFromTopics } from './csv.js'
import { refreshBoards } from './library.js'

let editingBoardId = null
let lastParse = { topics: [], errors: [], warnings: [] }

// Open with a board → edit mode (CSV regenerated from stored JSON, SPEC §6.3);
// open with null → create mode.
export function openEditor(board) {
  editingBoardId = board?.id ?? null
  $('editor-title').textContent = board ? `Edit: ${board.name}` : 'New board'
  $('editor-name').value = board?.name ?? ''
  $('editor-csv').value = board ? csvFromTopics(board.topics) : ''
  $('editor-status').textContent = ''
  renderParse()
  showView('view-editor')
}

function renderParse() {
  const csv = $('editor-csv').value
  lastParse = csv.trim() === '' ? { topics: [], errors: [], warnings: [] } : boardFromCsv(csv)
  renderProblems()
  renderPreview()
  updateSaveState()
}

function renderProblems() {
  const box = $('editor-problems')
  const { errors, warnings } = lastParse
  box.replaceChildren(
    ...errors.map((e) => el('p', { class: 'problem problem-error' }, `✖ ${e.message}`)),
    ...warnings.map((w) => el('p', { class: 'problem problem-warning' }, `⚠ ${w.message}`)),
  )
}

function renderPreview() {
  const box = $('editor-preview')
  const { topics } = lastParse
  if (topics.length === 0) {
    box.replaceChildren()
    return
  }
  const maxRows = Math.max(...topics.map((t) => t.cells.length))
  const table = el(
    'table',
    { class: 'preview-table' },
    el('thead', {}, el('tr', {}, ...topics.map((t) => el('th', {}, t.name)))),
    el(
      'tbody',
      {},
      ...Array.from({ length: maxRows }, (_, row) =>
        el(
          'tr',
          {},
          ...topics.map((t) => {
            const cell = t.cells[row]
            if (!cell) return el('td', { class: 'preview-blank' }, '—')
            return el(
              'td',
              {},
              el('span', { class: 'preview-points' }, String(cell.points)),
              el('span', { class: 'preview-q', title: `A: ${cell.answer}` }, cell.question),
            )
          }),
        ),
      ),
    ),
  )
  box.replaceChildren(el('h3', {}, 'Preview'), table)
}

function updateSaveState() {
  const nameOk = $('editor-name').value.trim() !== ''
  const csvOk = $('editor-csv').value.trim() !== '' && lastParse.errors.length === 0
  $('editor-save-btn').disabled = !(nameOk && csvOk)
}

async function save() {
  const name = $('editor-name').value.trim()
  const csv = $('editor-csv').value
  const btn = $('editor-save-btn')
  btn.disabled = true
  try {
    const payload = { name, csv }
    const result = editingBoardId
      ? await api.put(`/api/boards/${editingBoardId}`, payload)
      : await api.post('/api/boards', payload)
    toast(
      result.warnings.length > 0
        ? `Saved "${name}" with ${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}`
        : `Saved "${name}"`,
    )
    await refreshBoards()
    showView('view-library')
  } catch (err) {
    // Server-side validation is the gate; surface whatever it rejected.
    const messages = err.data?.errors?.map((e) => e.message) ?? [err.message]
    $('editor-problems').replaceChildren(
      ...messages.map((m) => el('p', { class: 'problem problem-error' }, `✖ ${m}`)),
    )
  } finally {
    btn.disabled = false
    updateSaveState()
  }
}

export function wireEditor() {
  let debounce
  $('editor-csv').addEventListener('input', () => {
    clearTimeout(debounce)
    debounce = setTimeout(renderParse, 250)
  })
  $('editor-name').addEventListener('input', updateSaveState)
  $('editor-save-btn').addEventListener('click', save)
  $('editor-back-btn').addEventListener('click', () => showView('view-library'))
  $('csv-upload-btn').addEventListener('click', () => $('csv-file').click())
  $('csv-file').addEventListener('change', async (e) => {
    const file = e.target.files[0]
    e.target.value = ''
    if (!file) return
    $('editor-csv').value = await file.text()
    renderParse()
  })
}
