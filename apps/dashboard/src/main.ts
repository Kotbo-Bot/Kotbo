import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { captureLandingKit } from './lib/onboarding/landingKit'

// Le serveur préparé sur kotbo.fr arrive dans l'URL de « Mes serveurs ». Il est
// retenu avant tout routage : la garde de connexion peut rediriger et perdre la
// requête avant qu'une page ait eu le temps de la lire.
captureLandingKit(window.location.search)

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
// Uniquement en production pour ne pas interférer avec le HMR de Vite.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}

const app = mount(App, {
  target: document.getElementById('app'),
})

export default app
