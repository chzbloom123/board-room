// Admin panel: plain, utilitarian maintenance hatch (SPEC §3, §6.8).
import { api } from './api.js'
import { $, el, toast } from './ui.js'
import { applyTheme } from './prefs.js'

applyTheme()

let profiles = []
let boards = []

function show(viewId) {
  for (const id of ['view-admin-login', 'view-admin']) $(id).hidden = id !== viewId
}

const when = (iso) => new Date(iso).toLocaleString()

async function refresh() {
  ;[profiles, boards] = await Promise.all([api.get('/api/admin/profiles'), api.get('/api/admin/boards')])
  const sessions = await api.get('/api/admin/sessions')
  renderProfiles()
  renderBoards()
  renderSessions(sessions)
}

function renderProfiles() {
  $('profiles-table').querySelector('tbody').replaceChildren(
    ...profiles.map((p) =>
      el(
        'tr',
        {},
        el('td', { class: 'admin-strong' }, p.name),
        el('td', {}, String(p.boardCount)),
        el('td', {}, p.activeSessionCount ? `${p.activeSessionCount} live` : '—'),
        el('td', { class: 'admin-dim' }, when(p.createdAt)),
        el(
          'td',
          { class: 'admin-actions' },
          el('button', { class: 'btn btn-quiet btn-small', onclick: () => renameProfile(p) }, 'Rename'),
          el('button', { class: 'btn btn-quiet btn-small', onclick: () => resetPassword(p) }, 'Reset password'),
          el('button', { class: 'btn btn-danger btn-small', onclick: () => deleteProfile(p), disabled: p.boardCount > 0 || p.activeSessionCount > 0, title: p.boardCount > 0 ? 'Move or delete its boards first' : '' }, 'Delete'),
        ),
      ),
    ),
  )
}

function renderBoards() {
  const q = $('admin-board-search').value.trim().toLowerCase()
  const shown = q ? boards.filter((b) => b.name.toLowerCase().includes(q) || b.owner.name.toLowerCase().includes(q)) : boards
  $('boards-table').querySelector('tbody').replaceChildren(
    ...shown.map((b) => {
      const select = el('select', { class: 'admin-select', ariaLabel: `Move "${b.name}" to` })
      select.append(
        el('option', { value: '' }, 'Move to…'),
        ...profiles.filter((p) => p.id !== b.owner.id).map((p) => el('option', { value: p.id }, p.name)),
      )
      select.addEventListener('change', () => select.value && moveBoard(b, select.value))
      return el(
        'tr',
        {},
        el('td', { class: 'admin-strong' }, b.name, b.hasFinal ? ' ★' : '', b.hasActiveSession ? el('span', { class: 'session-chip' }, 'Live') : ''),
        el('td', {}, b.owner.name),
        el('td', { class: 'admin-dim' }, `${b.topicCount} × ${b.questionCount}`),
        el('td', { class: 'admin-dim' }, when(b.updatedAt)),
        el(
          'td',
          { class: 'admin-actions' },
          select,
          el('button', { class: 'btn btn-danger btn-small', onclick: () => deleteBoard(b) }, 'Delete'),
        ),
      )
    }),
  )
  $('admin-boards-empty').hidden = boards.length > 0
}

function renderSessions(sessions) {
  $('sessions-table').querySelector('tbody').replaceChildren(
    ...sessions.map((s) =>
      el(
        'tr',
        {},
        el('td', { class: 'admin-strong' }, s.boardName),
        el('td', {}, s.owner.name),
        el('td', { class: 'admin-dim' }, s.players.join(' · ')),
        el('td', { class: 'admin-dim' }, when(s.updatedAt)),
        el('td', { class: 'admin-actions' }, el('button', { class: 'btn btn-danger btn-small', onclick: () => endSession(s) }, 'Force end')),
      ),
    ),
  )
  $('admin-sessions-empty').hidden = sessions.length > 0
}

async function guarded(action, successMessage) {
  try {
    await action()
    if (successMessage) toast(successMessage)
    await refresh()
  } catch (err) {
    toast(err.message, 'error')
  }
}

async function createProfile(e) {
  e.preventDefault()
  const form = new FormData(e.target)
  const name = form.get('name')
  await guarded(async () => {
    await api.post('/api/admin/profiles', { name, password: form.get('password') })
    e.target.reset()
  }, `Created "${name}"`)
}

function renameProfile(p) {
  const name = prompt(`Rename "${p.name}" to:`, p.name)
  if (!name || name.trim() === p.name) return
  guarded(() => api.put(`/api/admin/profiles/${p.id}`, { name }), `Renamed to "${name.trim()}"`)
}

function resetPassword(p) {
  const password = prompt(`New password for "${p.name}" (8+ characters):`)
  if (!password) return
  guarded(() => api.post(`/api/admin/profiles/${p.id}/password`, { password }), `Password reset for "${p.name}"`)
}

function deleteProfile(p) {
  if (!confirm(`Delete the instructor profile "${p.name}"? Its login stops working immediately.`)) return
  guarded(() => api.del(`/api/admin/profiles/${p.id}`), `Deleted "${p.name}"`)
}

function moveBoard(b, ownerProfileId) {
  const target = profiles.find((p) => p.id === ownerProfileId)
  if (!confirm(`Move "${b.name}" from ${b.owner.name} to ${target?.name}? Any game in progress moves with it.`)) {
    renderBoards()
    return
  }
  guarded(() => api.put(`/api/admin/boards/${b.id}/owner`, { ownerProfileId }), `Moved "${b.name}" to ${target?.name}`)
}

function deleteBoard(b) {
  if (!confirm(`Delete "${b.name}" (owned by ${b.owner.name})? This cannot be undone.`)) return
  guarded(() => api.del(`/api/admin/boards/${b.id}`), `Deleted "${b.name}"`)
}

function endSession(s) {
  if (!confirm(`Force-end the game on "${s.boardName}" run by ${s.owner.name}?`)) return
  guarded(() => api.post(`/api/admin/sessions/${s.id}/end`), 'Game ended')
}

$('admin-login-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const errEl = $('admin-login-error')
  errEl.hidden = true
  const form = new FormData(e.target)
  try {
    await api.post('/api/admin/login', { user: form.get('user'), password: form.get('password') })
    e.target.reset()
    await enterPanel()
  } catch (err) {
    errEl.textContent = err.message
    errEl.hidden = false
  }
})

$('admin-logout-btn').addEventListener('click', async () => {
  await api.post('/api/logout')
  show('view-admin-login')
})
$('create-profile-form').addEventListener('submit', createProfile)
$('admin-board-search').addEventListener('input', renderBoards)
$('admin-refresh-btn').addEventListener('click', () => guarded(async () => {}))

async function enterPanel() {
  const me = await api.get('/api/me')
  $('admin-user').textContent = me.user ?? 'admin'
  await refresh()
  show('view-admin')
}

try {
  const me = await api.get('/api/me')
  if (me.type === 'admin') await enterPanel()
  else show('view-admin-login')
} catch {
  show('view-admin-login')
}
