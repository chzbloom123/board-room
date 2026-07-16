import { api } from './api.js'
import { $, showView } from './ui.js'
import { enterLibrary, wireLibrary } from './library.js'
import { wireEditor } from './editor.js'

wireLibrary()
wireEditor()

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

// Boot: resume an existing session if the cookie is still valid.
try {
  const me = await api.get('/api/me')
  if (me.type === 'profile') await enterLibrary(me.profile)
  else showView('view-login')
} catch {
  showView('view-login')
}
