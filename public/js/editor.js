import { api } from './api.js'
import { $, el, showView, toast } from './ui.js'
// The same parser the server validates with — one pipeline, two callers.
import { boardFromCsv, csvFromTopics, looksTabSeparated, tsvToCsv } from './csv.js'
import { refreshBoards } from './library.js'

let editingBoardId = null
let lastParse = { topics: [], final: null, errors: [], warnings: [] }
let selectedCell = null // { ti, ci } highlighted in the preview

// Open with a board → edit mode (CSV regenerated from stored JSON, SPEC §6.3);
// open with null → create mode.
export function openEditor(board) {
  editingBoardId = board?.id ?? null
  selectedCell = null
  $('editor-title').textContent = board ? `Edit: ${board.name}` : 'New board'
  $('editor-name').value = board?.name ?? ''
  $('editor-csv').value = board ? csvFromTopics(board.topics, board.final ?? null) : ''
  $('editor-status').textContent = ''
  renderParse()
  showView('view-editor')
  if (!board) $('editor-name').focus()
}

function renderParse() {
  const csv = $('editor-csv').value
  const tabbed = looksTabSeparated(csv)
  $('editor-tsv-hint').hidden = !tabbed
  lastParse = csv.trim() === '' || tabbed ? { topics: [], final: null, errors: [], warnings: [] } : boardFromCsv(csv)
  renderStats()
  renderProblems()
  renderPreview()
  updateSaveState()
}

function renderStats() {
  const box = $('editor-stats')
  const { topics, errors } = lastParse
  if (topics.length === 0) {
    box.replaceChildren()
    return
  }
  const counts = topics.map((t) => t.cells.length)
  const questions = counts.reduce((a, b) => a + b, 0)
  const even = new Set(counts).size === 1
  const classic = topics.length === 6 && even && counts[0] === 5
  box.replaceChildren(
    el('span', {}, el('strong', {}, String(topics.length)), topics.length === 1 ? ' topic' : ' topics'),
    el('span', {}, el('strong', {}, String(questions)), ' questions'),
    el('span', {}, even ? `${counts[0]} per topic` : `${Math.min(...counts)}–${Math.max(...counts)} per topic`),
    el(
      'span',
      { class: errors.length ? 'stat-warn' : classic ? 'stat-ok' : '' },
      errors.length ? `${errors.length} error${errors.length === 1 ? '' : 's'} to fix` : classic ? '✓ Classic 6 × 5 board' : 'Custom shape',
    ),
    el(
      'span',
      { class: lastParse.final ? 'stat-ok' : '', title: 'Add one row with "final" as the points to include a final round' },
      lastParse.final ? '★ Final round included' : 'No final round',
    ),
  )
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
    el('thead', {}, el('tr', {}, ...topics.map((t) => el('th', { title: t.name }, t.name)))),
    el(
      'tbody',
      {},
      ...Array.from({ length: maxRows }, (_, row) =>
        el(
          'tr',
          {},
          ...topics.map((t, ti) => {
            const cell = t.cells[row]
            if (!cell) return el('td', { class: 'preview-blank' }, '—')
            const selected = selectedCell && selectedCell.ti === ti && selectedCell.ci === row
            return el(
              'td',
              {
                class: selected ? 'preview-selected' : '',
                title: 'Click to read the full question and answer',
                onclick: () => {
                  selectedCell = selected ? null : { ti, ci: row }
                  renderPreview()
                },
              },
              el('span', { class: 'preview-points' }, String(cell.points)),
              el('span', { class: 'preview-q' }, cell.question),
            )
          }),
        ),
      ),
    ),
  )
  const children = [el('h3', {}, 'Preview — how the board will look')]
  if (selectedCell && topics[selectedCell.ti]?.cells[selectedCell.ci]) {
    const t = topics[selectedCell.ti]
    const c = t.cells[selectedCell.ci]
    children.push(
      el(
        'div',
        { class: 'preview-detail' },
        el('div', { class: 'preview-detail-head' }, `${t.name} · ${c.points}`),
        el('div', { class: 'preview-detail-q' }, c.question),
        el('div', { class: 'preview-detail-a' }, c.answer),
      ),
    )
  }
  children.push(table)
  if (lastParse.final) {
    const f = lastParse.final
    children.push(
      el(
        'div',
        { class: 'preview-final' },
        el('span', { class: 'preview-final-label' }, `★ Final · ${f.category}`),
        el('span', { class: 'preview-final-q' }, f.question),
        el('span', { class: 'preview-final-a' }, `Answer: ${f.answer}`),
      ),
    )
  }
  box.replaceChildren(...children)
}

function updateSaveState() {
  const nameOk = $('editor-name').value.trim() !== ''
  const csvOk = $('editor-csv').value.trim() !== '' && lastParse.errors.length === 0 && lastParse.topics.length > 0
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

function setCsv(text) {
  $('editor-csv').value = text
  selectedCell = null
  renderParse()
}

function downloadTemplate() {
  const a = el('a', { href: '/samples/template.csv', download: 'board-template.csv' })
  document.body.append(a)
  a.click()
  a.remove()
}

async function loadSample() {
  if ($('editor-csv').value.trim() !== '' && !confirm('Replace the current questions with the sample board?')) return
  setCsv(await (await fetch('/samples/sample-board.csv')).text())
  if ($('editor-name').value.trim() === '') $('editor-name').value = 'Sample board'
  updateSaveState()
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
  $('csv-template-btn').addEventListener('click', downloadTemplate)
  $('csv-sample-btn').addEventListener('click', loadSample)
  $('csv-convert-btn').addEventListener('click', () => setCsv(tsvToCsv($('editor-csv').value)))
  $('csv-file').addEventListener('change', async (e) => {
    const file = e.target.files[0]
    e.target.value = ''
    if (!file) return
    setCsv(await file.text())
  })
}
