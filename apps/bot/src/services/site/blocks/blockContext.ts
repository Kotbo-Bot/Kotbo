/**
 * Contexte commun aux blocs de modules du site.
 *
 * Un bloc reçoit ce contexte et sa configuration (déjà normalisée), et rend un
 * fragment HTML. Les blocs n'écrivent jamais : les actions passent par les
 * routes du site, qui revérifient tout côté serveur.
 */

import type { Client, Guild } from 'discord.js';
import type { SiteModuleKey } from '@kotbo/shared';
import type { ModuleStates } from '../../core/moduleGate.js';
import type { SiteRecord, SiteViewer } from '../siteService.js';
import { attrs, esc, initials } from '../siteHtml.js';

export type SiteLocale = 'fr' | 'en';

export interface BlockContext {
  client: Client;
  site: SiteRecord;
  guild: Guild | null;
  locale: SiteLocale;
  /** Racine du site : `/s/mon-serveur`. */
  basePath: string;
  /** Nul au rendu serveur : le cookie de session ne vit pas sur ce domaine. */
  viewer: SiteViewer | null;
  moduleStates: ModuleStates;
}

/** Repère d'un bloc dans sa page : le script du site s'en sert pour le recharger. */
export interface BlockRef {
  pageId: string;
  index: number;
}

export type BlockRenderer = (ctx: BlockContext, config: Record<string, unknown>, ref: BlockRef) => Promise<string>;

export type BlockRegistry = Partial<Record<SiteModuleKey, BlockRenderer>>;

const LOCALE_TAGS: Record<SiteLocale, string> = { fr: 'fr-FR', en: 'en-GB' };

export function formatDate(date: Date | string | null | undefined, locale: SiteLocale, style: 'full' | 'long' | 'medium' | 'short' = 'long'): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], { dateStyle: style, timeZone: 'Europe/Paris' }).format(d);
}

export function formatDateTime(date: Date | string | null | undefined, locale: SiteLocale): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Paris' }).format(d);
}

export function formatNumber(value: number, locale: SiteLocale): string {
  return new Intl.NumberFormat(LOCALE_TAGS[locale], { notation: value >= 100_000 ? 'compact' : 'standard' }).format(value);
}

/** Balise `<time>` lisible par les machines, date lisible par les humains. */
export function timeTag(date: Date | string | null | undefined, locale: SiteLocale, style: 'full' | 'long' | 'medium' | 'short' = 'long'): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return '';
  return `<time datetime="${esc(d.toISOString())}">${esc(formatDate(d, locale, style))}</time>`;
}

/** Avatar rond, ou initiales sur fond d'accent quand il n'y a pas d'image. */
export function avatar(url: string | null | undefined, name: string, size: 'sm' | 'md' | 'lg' = 'md'): string {
  if (url) {
    return `<img class="avatar avatar-${size}"${attrs({ src: url, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' })}>`;
  }
  return `<span class="avatar avatar-${size} avatar-fallback" aria-hidden="true">${esc(initials(name))}</span>`;
}

/** Message d'état vide, uniforme d'un bloc à l'autre. */
export function emptyState(text: string): string {
  return `<p class="empty">${esc(text)}</p>`;
}

/** Lien profond vers un message Discord. */
export function discordMessageUrl(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}
