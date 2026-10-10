/**
 * Annoncer les nouvelles notifications : notification de bureau, bulle, son.
 *
 * La cloche du header savait deja qu'une notification etait arrivee, mais ne le
 * disait a personne : il fallait avoir l'onglet sous les yeux et remarquer la
 * pastille. Ce module prend le relais des que la boite recoit quelque chose de
 * neuf, selon les deux preferences de l'utilisateur :
 *
 * - « Sons de notification » : un son par type (voir `notificationSounds`) ;
 * - « Notifications bureau » : une notification systeme quand on ne regarde
 *   pas le dashboard, une bulle dans la page quand on le regarde - une
 *   notification systeme par-dessus l'onglet qu'on est en train de lire ne
 *   ferait que doubler l'information.
 *
 * Plusieurs onglets du dashboard recoivent le meme evenement au meme moment :
 * chaque notification est « reservee » par un seul d'entre eux avant d'etre
 * annoncee, sans quoi trois onglets ouverts sonneraient trois fois.
 */

import { router } from 'tinro';
import { userPrefs } from './stores/userPreferences.svelte';
import { toast, type ToastType } from './stores/toast.svelte';
import { m } from './i18n';
import {
  playNotificationSound,
  primeNotificationAudio,
  type NotificationTone,
} from './notificationSounds';

export type AnnouncedNotification = {
  id: string;
  title: string;
  message: string;
  type: string;
  link?: string | null;
};

type DesktopPermission = NotificationPermission | 'unsupported';

const SEVERITY: Record<NotificationTone, number> = { INFO: 0, SUCCESS: 1, WARNING: 2, ERROR: 3 };
const TOAST_TYPE: Record<NotificationTone, ToastType> = {
  INFO: 'info',
  SUCCESS: 'success',
  WARNING: 'warning',
  ERROR: 'error',
};

/** Au-dela, une seule notification resume le lot au lieu d'en empiler autant. */
const MAX_INDIVIDUAL = 3;
const CLAIM_KEY = 'kotbo_notif_announced';
const CLAIM_MEMORY = 200;
const ICON_URL = `${import.meta.env.BASE_URL ?? '/'}icons/icon-192.png`.replace(/\/{2,}/g, '/');

export function toTone(type: string): NotificationTone {
  return type in SEVERITY ? (type as NotificationTone) : 'INFO';
}

// ── Ouverture d'une notification ─────────────────────────────────────────────

let openedHandler: ((id: string) => void) | null = null;

/** Le magasin des notifications s'y branche pour marquer comme lue. */
export function onNotificationOpened(handler: (id: string) => void): void {
  openedHandler = handler;
}

/** Seuls les chemins internes sont suivis : un lien vient d'une donnee stockee. */
function internalLink(link: string | null | undefined): string | null {
  if (!link || !link.startsWith('/') || link.startsWith('//')) return null;
  return link;
}

function openNotification(id: string | null, link: string | null | undefined): void {
  if (typeof window !== 'undefined') window.focus();
  const target = internalLink(link);
  if (target) router.goto(target);
  if (id && openedHandler) openedHandler(id);
}

// ── Permission ───────────────────────────────────────────────────────────────

export function desktopPermission(): DesktopPermission {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

export async function requestDesktopPermission(): Promise<DesktopPermission> {
  const current = desktopPermission();
  if (current !== 'default') return current;
  try {
    return await Notification.requestPermission();
  } catch {
    return desktopPermission();
  }
}

// ── Reservation entre onglets ────────────────────────────────────────────────

function readClaimed(): string[] {
  try {
    const raw = localStorage.getItem(CLAIM_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Garder les notifications qu'aucun autre onglet n'a encore annoncees.
 *
 * Le verrou Web Locks rend la lecture et l'ecriture atomiques entre onglets ;
 * sans lui (navigateur ancien), on accepte le risque d'un doublon plutot que de
 * ne rien annoncer.
 */
async function claim<T extends { id: string }>(items: T[]): Promise<T[]> {
  const run = () => {
    const claimed = readClaimed();
    const known = new Set(claimed);
    const fresh = items.filter((item) => !known.has(item.id));
    if (fresh.length > 0) {
      try {
        const next = [...claimed, ...fresh.map((item) => item.id)].slice(-CLAIM_MEMORY);
        localStorage.setItem(CLAIM_KEY, JSON.stringify(next));
      } catch {
        // Mode prive : chaque onglet annonce pour lui-meme.
      }
    }
    return fresh;
  };

  try {
    if (typeof navigator !== 'undefined' && navigator.locks) {
      return await navigator.locks.request('kotbo-notif-announce', run);
    }
  } catch {
    // Verrou indisponible : on retombe sur la version sans verrou.
  }
  return run();
}

// ── Notification systeme ─────────────────────────────────────────────────────

/**
 * Le service worker est prefere quand il est la : c'est lui qui recoit le clic
 * meme si l'onglet a ete ferme entre-temps, et c'est la seule voie qui marche
 * sur Android. En developpement il n'est pas enregistre, d'ou le repli.
 */
async function showSystemNotification(
  item: { id: string | null; title: string; body: string; link?: string | null; tone: NotificationTone },
  silent: boolean,
): Promise<boolean> {
  const options: NotificationOptions & { renotify?: boolean } = {
    body: item.body,
    icon: ICON_URL,
    badge: ICON_URL,
    tag: item.id ? `kotbo-notif-${item.id}` : 'kotbo-notif-summary',
    renotify: !item.id,
    silent,
    // Une erreur reste affichee jusqu'a ce qu'on la traite.
    requireInteraction: item.tone === 'ERROR',
    data: { id: item.id, link: internalLink(item.link) },
  };

  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    if (registration?.active) {
      await registration.showNotification(item.title, options);
      return true;
    }
  } catch {
    // Repli sur le constructeur ci-dessous.
  }

  try {
    const notification = new Notification(item.title, options);
    notification.onclick = () => {
      notification.close();
      openNotification(item.id, item.link);
    };
    return true;
  } catch {
    return false;
  }
}

function pageIsWatched(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

function loudest(items: AnnouncedNotification[]): NotificationTone {
  return items
    .map((item) => toTone(item.type))
    .reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), 'INFO' as NotificationTone);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ── Point d'entree ───────────────────────────────────────────────────────────

/**
 * Annoncer des notifications qui viennent d'arriver.
 *
 * Un seul son pour le lot, celui du type le plus grave : trois notifications
 * d'un coup ne doivent pas jouer trois fois, et une erreur ne doit pas etre
 * couverte par le son d'un succes arrive dans la meme seconde.
 */
export async function announceNotifications(items: AnnouncedNotification[]): Promise<void> {
  if (typeof window === 'undefined' || items.length === 0) return;
  const { soundNotifications, desktopNotifications } = userPrefs.prefs;
  if (!soundNotifications && !desktopNotifications) return;

  const fresh = await claim(items);
  if (fresh.length === 0) return;

  const tone = loudest(fresh);
  const soundPlayed = soundNotifications ? playNotificationSound(tone) : false;

  if (!desktopNotifications) return;

  if (pageIsWatched()) {
    for (const item of fresh.slice(0, MAX_INDIVIDUAL)) {
      const text = item.message ? `${item.title} · ${truncate(item.message, 120)}` : item.title;
      toast.add(text, TOAST_TYPE[toTone(item.type)], 7000, {
        label: m.notif_toast_view(),
        onClick: () => openNotification(item.id, item.link ?? '/inbox'),
      });
    }
    return;
  }

  if (desktopPermission() !== 'granted') return;

  // Si notre son est parti, ou si l'utilisateur a coupe les sons, le systeme se
  // tait. Reste le cas d'un audio jamais deverrouille (onglet ouvert sans y
  // avoir clique) : on laisse alors le systeme jouer le sien.
  const silent = soundPlayed || !soundNotifications;

  if (fresh.length > MAX_INDIVIDUAL) {
    await showSystemNotification(
      {
        id: null,
        title: 'Kotbo',
        body: m.notif_desktop_many({ count: fresh.length }),
        link: '/inbox',
        tone,
      },
      silent,
    );
    return;
  }

  for (const item of fresh) {
    await showSystemNotification(
      {
        id: item.id,
        title: item.title,
        body: truncate(item.message ?? '', 300),
        link: item.link,
        tone: toTone(item.type),
      },
      silent,
    );
  }
}

/**
 * L'apercu du bouton « Tester les notifications ».
 *
 * Contrairement a une vraie annonce, il passe toujours par une notification
 * systeme, meme onglet au premier plan : c'est justement ce qu'on veut voir.
 */
export async function sendTestNotification(tone: NotificationTone = 'INFO'): Promise<DesktopPermission> {
  const permission = await requestDesktopPermission();
  const { soundNotifications } = userPrefs.prefs;
  const soundPlayed = soundNotifications ? playNotificationSound(tone, { force: true }) : false;
  if (permission === 'granted') {
    await showSystemNotification(
      { id: null, title: 'Kotbo', body: m.us_notif_preview_body(), link: null, tone },
      soundPlayed || !soundNotifications,
    );
  }
  return permission;
}

// ── Branchements globaux ─────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  primeNotificationAudio();

  // Clic sur une notification affichee par le service worker : il retrouve un
  // onglet du dashboard et lui transmet le lien a ouvrir.
  const container = navigator.serviceWorker;
  if (container) {
    container.addEventListener('message', (event: MessageEvent) => {
      const data = event.data;
      if (!data || data.type !== 'KOTBO_NOTIFICATION_OPEN') return;
      openNotification(typeof data.id === 'string' ? data.id : null, typeof data.link === 'string' ? data.link : null);
    });
    container.startMessages?.();
  }
}
