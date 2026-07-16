import { api } from './api.js'

const views = {
  login: document.getElementById('view-login'),
  library: document.getElementById('view-library'),
}

function show(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name
}

async function enterLibrary(profile) {
  document.getElementById('profile-name').textContent = profile.name
  const boards = await api.get('/api/boards')
  const list = document.getElementById('board-list')
  list.replaceChildren(
    ...boards.map((b) => {
      const li = document.createElement('li')
      li.className = 'board-row'
      li.textContent = `${b.name} — ${b.topicCount} topics, ${b.questionCount} questions`
      return li
    }),
  )
  document.getElementById('library-empty').hidden = boards.length > 0
  show('library')
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const errEl = document.getElementById('login-error')
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

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api.post('/api/logout')
  show('login')
})

// Boot: resume an existing session if the cookie is still valid.
try {
  const me = await api.get('/api/me')
  if (me.type === 'profile') await enterLibrary(me.profile)
  else show('login')
} catch {
  show('login')
}
