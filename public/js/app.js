import { api } from './api.js'
import { $, showView, toast } from './ui.js'
import { enterLibrary, wireLibrary } from './library.js'
import { wireEditor } from './editor.js'
import { wireGame } from './game.js'
import { prefs, THEMES, applyTheme } from './prefs.js'

// Theme is a per-browser preference; every topbar carries the same picker.
applyTheme()
for (const select of document.querySelectorAll('.theme-select')) {
  select.replaceChildren(
    ...THEMES.map((t) => {
      const opt = document.createElement('option')
      opt.value = t.id
      opt.textContent = t.label
      return opt
    }),
  )
  select.value = prefs.theme
  select.addEventListener('change', () => {
    prefs.theme = select.value
    for (const other of document.querySelectorAll('.theme-select')) other.value = select.value
  })
}

wireLibrary()
wireEditor()
wireGame()

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const errEl = $('login-error')
  errEl.hidden = true
  const form = new FormData(e.target)
  try {
    const { profile } = await api.post('/api/login', {
      name: form.get('name'),
      password: form.get('password'),
    })
    e.target.reset()
    await enterLibrary(profile)
  } catch (err) {
    errEl.textContent = err.message
    errEl.hidden = false
  }
})

$('logout-btn').addEventListener('click', async () => {
  await api.post('/api/logout')
  showView('view-login')
})

// ---- Self-service sign-up ----
// The server says whether sign-up is open, code-gated, or closed; the form
// adapts. All auth travels in the cookie the server sets — never a URL.
let registration = 'open'
try {
  registration = (await api.get('/api/config')).registration
} catch {
  // Default to "open" in the UI; the server still enforces the real rule.
}

function showAuthForm(which) {
  const register = which === 'register'
  $('login-form').hidden = register
  $('register-form').hidden = !register
  $('show-register-btn').hidden = register
  $('show-login-btn').hidden = !register
  $('login-error').hidden = true
  $('register-error').hidden = true
  if (register) $('register-form').querySelector('input[name="name"]').focus()
}

if (registration === 'closed') {
  $('show-register-btn').hidden = true
  $('register-closed').hidden = false
} else {
  $('register-code-label').hidden = registration !== 'code'
  $('register-form').querySelector('input[name="code"]').required = registration === 'code'
}
$('show-register-btn').addEventListener('click', () => showAuthForm('register'))
$('show-login-btn').addEventListener('click', () => showAuthForm('login'))

$('register-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const errEl = $('register-error')
  errEl.hidden = true
  const form = new FormData(e.target)
  if (form.get('password') !== form.get('confirm')) {
    errEl.textContent = 'Passwords do not match'
    errEl.hidden = false
    return
  }
  try {
    const { profile } = await api.post('/api/register', {
      name: form.get('name'),
      password: form.get('password'),
      code: form.get('code') || undefined,
    })
    e.target.reset()
    showAuthForm('login')
    toast(`Welcome, ${profile.name} — this is your board library`)
    await enterLibrary(profile)
  } catch (err) {
    errEl.textContent = err.message
    errEl.hidden = false
  }
})

// ---- Change own password ----
$('account-btn').addEventListener('click', () => {
  $('account-profile-name').textContent = $('profile-name').textContent
  $('account-error').hidden = true
  $('account-form').reset()
  $('account-modal').hidden = false
  $('account-form').querySelector('input').focus()
})
$('account-cancel-btn').addEventListener('click', () => ($('account-modal').hidden = true))
$('account-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) $('account-modal').hidden = true
})
$('account-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const errEl = $('account-error')
  errEl.hidden = true
  const form = new FormData(e.target)
  if (form.get('newPassword') !== form.get('confirm')) {
    errEl.textContent = 'New passwords do not match'
    errEl.hidden = false
    return
  }
  try {
    await api.post('/api/me/password', {
      currentPassword: form.get('currentPassword'),
      newPassword: form.get('newPassword'),
    })
    $('account-modal').hidden = true
    toast('Password changed')
  } catch (err) {
    errEl.textContent = err.message
    errEl.hidden = false
  }
})

// Boot: resume an existing session if the cookie is still valid.
try {
  const me = await api.get('/api/me')
  if (me.type === 'profile') await enterLibrary(me.profile)
  else showView('view-login')
} catch {
  showView('view-login')
}
