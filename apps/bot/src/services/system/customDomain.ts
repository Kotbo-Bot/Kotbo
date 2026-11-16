/**
 * Dashboard sur le domaine d'un serveur (offre Plus).
 *
 * Le serveur pointe son domaine (CNAME) sur CUSTOM_DOMAIN_TARGET et prouve
 * qu'il le possède par un TXT `_kotbo.<domaine>`. Traefik lit la liste des
 * domaines actifs sur /api/internal/custom-domains/traefik et sert, sur chacun,
 * la SPA du dashboard et l'API sous /api : tout reste sur la même origine, donc
 * le cookie de session est un cookie propriétaire du domaine. La connexion
 * passe par l'application Discord du serveur (botClientId / botClientSecret),
 * la seule où il peut déclarer l'URL de retour de son domaine.
 */
import { resolve4, resolveTxt } from 'node:dns/promises';
import { comparePlans, normalizePlanKey } from '@kotbo/contracts';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { cloudflareSaasEnabled, ensureCloudflareHostname } from './cloudflareHostnames.js';

export interface CustomDomainEntry {
  guildId: string;
  host: string;
  clientId: string;
  /** Secret scellé (secretBox), ouvert seulement au moment de l'échange OAuth. */
  sealedClientSecret: string;
  botName: string | null;
  botAvatarUrl: string | null;
  /** Port de l'API de l'instance qui sert ce serveur, ou null : l'API de Kotbo. */
  apiPort: number | null;
}

const HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const REFRESH_MS = 60_000;

/** Cible du CNAME à créer, ou null si l'instance ne propose pas les domaines perso. */
export function customDomainTarget(): string | null {
  return process.env.CUSTOM_DOMAIN_TARGET?.trim().toLowerCase() || null;
}

/**
 * Nom d'hôte saisi par le serveur, sans schéma, chemin ni port. Refuse les
 * domaines Kotbo : un serveur ne doit pas pouvoir revendiquer dash.kotbo.fr.
 */
export function normalizeCustomDomain(raw: string): string | null {
  let text = raw.trim().toLowerCase();
  if (!text) return null;
  if (!/^https?:\/\//.test(text)) text = `https://${text}`;
  let host: string;
  try {
    host = new URL(text).hostname.replace(/\.$/, '');
  } catch {
    return null;
  }
  if (!HOST_RE.test(host)) return null;
  if (host === 'kotbo.fr' || host.endsWith('.kotbo.fr')) return null;
  return host;
}

export function verificationRecord(host: string, guildId: string) {
  return { name: `_kotbo.${host}`, value: `kotbo-verify=${guildId}` };
}

/**
 * Vérifie les deux enregistrements. `pointing` compare les adresses IPv4 du
 * domaine à celles de la cible : un domaine derrière le proxy Cloudflare
 * (nuage orange) échoue ici, Traefik ne pourrait pas obtenir son certificat.
 */
export async function checkCustomDomainDns(host: string, guildId: string): Promise<{ txt: boolean; pointing: boolean }> {
  const record = verificationRecord(host, guildId);
  const txtRecords = await resolveTxt(record.name).catch(() => [] as string[][]);
  const txt = txtRecords.some((parts) => parts.join('').trim() === record.value);

  // Cloudflare for SaaS : le domaine est proxifié, donc ses IP ne sont pas celles de la cible.
  // « pointing » devient « Cloudflare a vu le CNAME et émis le certificat ».
  if (cloudflareSaasEnabled()) {
    return { txt, pointing: txt ? await ensureCloudflareHostname(host) : false };
  }

  const target = customDomainTarget();
  const [targetIps, hostIps] = await Promise.all([
    target ? resolve4(target).catch(() => [] as string[]) : Promise.resolve([] as string[]),
    resolve4(host).catch(() => [] as string[]),
  ]);
  return { txt, pointing: hostIps.length > 0 && hostIps.every((ip) => targetIps.includes(ip)) };
}

let byHost = new Map<string, CustomDomainEntry>();
let timer: ReturnType<typeof setInterval> | null = null;

/** Domaines servis : vérifiés, identifiants OAuth renseignés, offre Plus ou plus. */
export async function refreshCustomDomains(): Promise<CustomDomainEntry[]> {
  try {
    const rows = await prisma.customBotConfig.findMany({
      where: {
        customDashboardUrl: { not: null },
        customDomainVerifiedAt: { not: null },
        botClientId: { not: null },
        botClientSecret: { not: null },
      },
      select: {
        guildId: true,
        customDashboardUrl: true,
        botClientId: true,
        botClientSecret: true,
        botName: true,
        botAvatarUrl: true,
        guild: { select: { plan: true, instance: { select: { apiPort: true, enabled: true } } } },
      },
    });
    const next = new Map<string, CustomDomainEntry>();
    for (const row of rows) {
      if (comparePlans(normalizePlanKey(row.guild.plan), 'PLUS') < 0) continue;
      next.set(row.customDashboardUrl!, {
        guildId: row.guildId,
        host: row.customDashboardUrl!,
        clientId: row.botClientId!,
        sealedClientSecret: row.botClientSecret!,
        botName: row.botName,
        botAvatarUrl: row.botAvatarUrl,
        apiPort: row.guild.instance?.enabled ? row.guild.instance.apiPort : null,
      });
    }
    byHost = next;
  } catch (err) {
    logger.warn('CustomDomain', 'Liste des domaines perso non rafraîchie :', err);
  }
  return [...byHost.values()];
}

/**
 * Les contrôles d'origine (CORS, WebSocket) sont synchrones : ils lisent ce
 * cache, rafraîchi chaque minute. shortcut: un domaine vérifié sur un autre
 * processus met jusqu'à une minute à être accepté ici, à passer par Redis si
 * ce délai gêne.
 */
export function startCustomDomainSync(): void {
  if (timer) return;
  void refreshCustomDomains();
  timer = setInterval(() => void refreshCustomDomains(), REFRESH_MS);
  timer.unref?.();
}

function hostOnly(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/:\d+$/, '');
}

export function customDomainForHost(hostHeader: string | null | undefined): CustomDomainEntry | null {
  return byHost.get(hostOnly(hostHeader)) ?? null;
}

export function isCustomDomainOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && byHost.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Configuration dynamique lue par le fournisseur HTTP de Traefik. Les hôtes
 * sortent de normalizeCustomDomain : aucun accent grave ne peut s'y glisser.
 */
export function traefikDynamicConfig(
  domains: Array<{ host: string; apiPort?: number | null }>,
  env: Record<string, string | undefined> = process.env,
) {
  const apiUpstream = env.CUSTOM_DOMAIN_API_UPSTREAM;
  const dashboardUpstream = env.CUSTOM_DOMAIN_DASHBOARD_UPSTREAM;
  if (!apiUpstream || !dashboardUpstream || domains.length === 0) return { http: {} };

  // Derrière Cloudflare for SaaS, c'est Cloudflare qui présente le certificat au visiteur : Traefik
  // garde son certificat par défaut (SSL « Full » côté Cloudflare), pas de défi Let's Encrypt.
  const tls = cloudflareSaasEnabled(env) ? {} : { certResolver: env.CUSTOM_DOMAIN_CERT_RESOLVER || 'letsencrypt' };
  const routers: Record<string, unknown> = {};
  const services: Record<string, unknown> = {
    'kotbo-cd-api': { loadBalancer: { servers: [{ url: apiUpstream }] } },
    'kotbo-cd-dashboard': { loadBalancer: { servers: [{ url: dashboardUpstream }] } },
  };
  for (const { host, apiPort } of domains) {
    if (!HOST_RE.test(host)) continue;
    // Un serveur servi par son propre bot : son API est celle de son instance, même hôte, autre port.
    let apiService = 'kotbo-cd-api';
    if (apiPort) {
      apiService = `kotbo-cd-api-${apiPort}`;
      const upstream = new URL(apiUpstream);
      upstream.port = String(apiPort);
      services[apiService] = { loadBalancer: { servers: [{ url: upstream.origin }] } };
    }
    const key = `kotbo-cd-${host.replace(/[^a-z0-9]/g, '-')}`;
    const rule = `Host(\`${host}\`)`;
    routers[`${key}-api`] = { rule: `${rule} && PathPrefix(\`/api\`)`, service: apiService, entryPoints: ['websecure'], tls, priority: 200 };
    routers[key] = { rule, service: 'kotbo-cd-dashboard', entryPoints: ['websecure'], tls, priority: 100 };
    routers[`${key}-http`] = { rule, service: 'kotbo-cd-dashboard', entryPoints: ['web'], middlewares: ['kotbo-cd-https'] };
  }
  return {
    http: {
      routers,
      services,
      middlewares: { 'kotbo-cd-https': { redirectScheme: { scheme: 'https', permanent: true } } },
    },
  };
}
