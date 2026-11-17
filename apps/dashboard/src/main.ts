// En tête, avant tout le reste : en démonstration, le faux back-end doit
// remplacer `fetch` avant que le store de session ne lise la sienne.
import './lib/demo/install'
// Avant les stores : le serveur demande par un lien (?guild=) doit etre pose
// avant que la session ne lise le serveur courant.
import './lib/guildFromUrl'
import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'

if (import.meta.env.VITE_DEMO !== '1') {
  const nativeFetch = window.fetch.bind(window)
  const configuredApiUrl = (import.meta.env.VITE_API_URL ?? '').trim().replace(/\/$/, '')
  const apiOrigin = configuredApiUrl ? new URL(configuredApiUrl, window.location.origin).origin : window.location.origin

  window.fetch = (input: RequestInfo | URL, init: RequestInit = {}) => {
    const requestUrl = input instanceof Request ? input.url : new URL(String(input), window.location.origin).href
    if (new URL(requestUrl).origin !== apiOrigin) return nativeFetch(input, init)

    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    new Headers(init.headers).forEach((value, key) => headers.set(key, value))
    if (headers.get('Authorization') === 'Bearer cookie-session') headers.delete('Authorization')

    return nativeFetch(input, { ...init, headers, credentials: init.credentials ?? 'include' })
  }
}

// Le suivi d'erreurs ne doit pas retarder le premier rendu. Son chunk est
// chargé après l'événement load, pendant une période d'inactivité.
if (import.meta.env.VITE_SENTRY_DSN) {
  window.addEventListener('load', () => {
    const initialize = () => {
      void import('./lib/sentry').then(({ initDashboardSentry }) => initDashboardSentry())
    }

    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(initialize, { timeout: 2_000 })
    } else {
      window.setTimeout(initialize, 500)
    }
  }, { once: true })
}

// PWA : service worker (offline shell + widget Windows 11/Edge).
// Uniquement en production pour ne pas interférer avec le HMR de Vite, et
// jamais dans la démo : servie sous kotbo.fr/demo, elle enregistrerait un
// worker sur le site vitrine.
if (import.meta.env.PROD && import.meta.env.VITE_DEMO !== '1' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}

// Apres un deploiement, les chunks hashes de l'ancienne version n'existent plus :
// un import dynamique (fiche serveur, salon...) echoue et plante la page. On
// recharge une fois (garde 1 min contre une boucle) pour recuperer la nouvelle version.
function reloadOnStaleChunk() {
  try {
    const last = Number(sessionStorage.getItem('kotbo:chunk-reload') ?? 0)
    if (Date.now() - last < 60_000) return false
    sessionStorage.setItem('kotbo:chunk-reload', String(Date.now()))
  } catch {
    return false
  }
  window.location.reload()
  return true
}
window.addEventListener('vite:preloadError', (event) => {
  if (reloadOnStaleChunk()) event.preventDefault()
})
window.addEventListener('unhandledrejection', (event) => {
  const message = String((event.reason as Error | undefined)?.message ?? event.reason ?? '')
  if (/dynamically imported module|Importing a module script failed/i.test(message) && reloadOnStaleChunk()) {
    event.preventDefault()
  }
})

const app = mount(App, {
  target: document.getElementById('app'),
})

export default app
