// Small shared UI helpers: view switching, toast, element shorthand.
export const $ = (id) => document.getElementById(id)

const viewIds = ['view-login', 'view-library', 'view-editor', 'view-setup', 'view-game']

export function showView(id) {
  for (const viewId of viewIds) {
    const el = $(viewId)
    if (el) el.hidden = viewId !== id
  }
}

let toastTimer
export function toast(message, kind = 'info') {
  const el = $('toast')
  el.textContent = message
  el.className = `toast toast-${kind}`
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    el.hidden = true
  }, 3500)
}

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else if (key === 'dataset') Object.assign(node.dataset, value)
    else node[key] = value
  }
  node.append(...children)
  return node
}
