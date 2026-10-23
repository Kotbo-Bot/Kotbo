/* Service worker Kotbo - PWA (offline shell) + widget Windows 11/Edge */

const VERSION = 'v2';
const SHELL_CACHE = `kotbo-shell-${VERSION}`;
const WIDGET_TAG = 'kotbo-stats';

// ---------------------------------------------------------------------------
// Cycle de vie
// ---------------------------------------------------------------------------

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.add('/').catch(() => undefined)),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.enable();
    }
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith('kotbo-') && key !== SHELL_CACHE)
        .map((key) => caches.delete(key)),
    );
    await self.clients.claim();
  })());
});

// ---------------------------------------------------------------------------
// Stratégies de cache
//  - navigations : network-first, fallback sur le shell en cache (hors-ligne)
//  - /assets/ : cache HTTP natif (immutable côté nginx), sans duplication SW
//  - /api/ : jamais mis en cache
// ---------------------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = (await event.preloadResponse) || await fetch(request);
        if (fresh.ok) {
          const cache = await caches.open(SHELL_CACHE);
          cache.put('/', fresh.clone());
        }
        return fresh;
      } catch {
        const cached = await caches.match('/');
        if (cached) return cached;
        throw new Error('offline');
      }
    })());
    return;
  }
});

// ---------------------------------------------------------------------------
// Notifications de bureau du dashboard (affichées par notificationAlerts.ts).
// Un clic ramène sur un onglet ouvert et lui confie la navigation ; sans
// onglet, il en ouvre un directement sur la page concernée.
// ---------------------------------------------------------------------------

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const link = typeof data.link === 'string' && data.link.startsWith('/') && !data.link.startsWith('//')
    ? data.link
    : null;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const target = windows.find((client) => client.focused) || windows[0];
    if (target) {
      await target.focus().catch(() => undefined);
      target.postMessage({ type: 'KOTBO_NOTIFICATION_OPEN', id: data.id ?? null, link });
      return;
    }
    await self.clients.openWindow(link || '/inbox');
  })());
});

// ---------------------------------------------------------------------------
// Configuration du widget (token + base API), stockée en IndexedDB.
// La page Widget du dashboard pousse la config via postMessage.
// ---------------------------------------------------------------------------

const DB_NAME = 'kotbo-widget';
const STORE = 'config';

function openConfigDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readWidgetConfig() {
  try {
    const db = await openConfigDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get('current');
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function writeWidgetConfig(config) {
  const db = await openConfigDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(config, 'current');
    tx.oncomplete = () => resolve(undefined);
    tx.onerror = () => reject(tx.error);
  });
}

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'KOTBO_WIDGET_CONFIG') return;
  if (typeof msg.token !== 'string' || typeof msg.apiBase !== 'string') return;
  event.waitUntil(
    writeWidgetConfig({ token: msg.token, apiBase: msg.apiBase })
      .then(() => updateWidgets())
      .catch(() => undefined),
  );
});

// ---------------------------------------------------------------------------
// Widget Windows 11 / Edge (Web App Manifest `widgets` + Adaptive Cards)
// ---------------------------------------------------------------------------

const PLACEHOLDER_DATA = {
  server: { name: 'Kotbo', iconUrl: '', memberCount: '-' },
  user: { staffRank: 'Staff', level: '-', messageCount: '-', voiceMinutes: '-', staffScore: '-' },
  statusText: 'Ouvre le dashboard Kotbo (page Widget) pour connecter tes stats.',
};

async function fetchWidgetStats() {
  const config = await readWidgetConfig();
  if (!config || !config.token) return null;

  try {
    const res = await fetch(`${config.apiBase}/api/public/widget-data`, {
      headers: { Authorization: `Bearer ${config.token}` },
    });
    if (!res.ok) return null;
    const stats = await res.json();
    const updatedAt = new Date(stats.updatedAt);
    return {
      server: {
        name: stats.server.name,
        iconUrl: stats.server.iconUrl || '',
        memberCount: Number(stats.server.memberCount).toLocaleString('fr-FR'),
      },
      user: {
        staffRank: stats.user.staffRank,
        level: `${stats.user.level} lvl`,
        messageCount: Number(stats.user.messageCount).toLocaleString('fr-FR'),
        voiceMinutes: `${Number(stats.user.voiceMinutes).toLocaleString('fr-FR')} min`,
        staffScore: `${stats.user.staffScore} pts`,
      },
      statusText: `Mis à jour à ${updatedAt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`,
    };
  } catch {
    return null;
  }
}

async function updateWidgets() {
  if (!('widgets' in self)) return;

  const widget = await self.widgets.getByTag(WIDGET_TAG);
  if (!widget) return;

  const templateRes = await fetch(widget.definition.msAcTemplate);
  const template = await templateRes.text();
  const data = (await fetchWidgetStats()) ?? PLACEHOLDER_DATA;

  await self.widgets.updateByTag(WIDGET_TAG, {
    template,
    data: JSON.stringify(data),
  });
}

self.addEventListener('widgetinstall', (event) => {
  event.waitUntil(updateWidgets());
});

self.addEventListener('widgetresume', (event) => {
  event.waitUntil(updateWidgets());
});

self.addEventListener('widgetclick', (event) => {
  if (event.action === 'refresh') {
    event.waitUntil(updateWidgets());
  }
});

self.addEventListener('periodicsync', (event) => {
  if (event.tag === WIDGET_TAG) {
    event.waitUntil(updateWidgets());
  }
});
