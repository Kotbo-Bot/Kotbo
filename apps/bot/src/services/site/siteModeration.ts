/**
 * Modération de ce que publie un membre depuis le site (commentaires,
 * suggestions) et des liens d'une page avant sa publication.
 *
 * Trois filtres, du moins cher au plus cher : domaines d'arnaque connus,
 * textes d'arnaque connus (jeu de données du honeypot, serveur + global), puis
 * toxicité AegisAI quand le serveur l'a activé. AegisAI injoignable ne bloque
 * rien : le site ne doit pas tomber avec un service tiers.
 */

import { extractSiteDocumentText, type SiteDocument, type SiteNode } from '@kotbo/shared';
import { findKnownScamDomain, findKnownScamText } from '../moderation/scamDatasetService.js';
import { getAegisConfig } from '../moderation/aegis/aegisConfig.js';
import { getAegisClient } from '../moderation/aegis/aegisClient.js';
import { logger } from '../../utils/logger.js';

export interface ModerationVerdict {
  allowed: boolean;
  /** `scam_link:<domaine>`, `scam_text` ou `toxicity:<score>`. */
  reason: string | null;
}

const AEGIS_TIMEOUT_MS = 3000;

export async function moderateMemberText(guildId: string, text: string): Promise<ModerationVerdict> {
  const domain = await findKnownScamDomain(guildId, text).catch(() => null);
  if (domain) return { allowed: false, reason: `scam_link:${domain}` };
  if (await findKnownScamText(guildId, text).catch(() => false)) return { allowed: false, reason: 'scam_text' };

  const config = await getAegisConfig(guildId).catch(() => null);
  const client = getAegisClient();
  if (config && client.available) {
    try {
      // `save: false` : un commentaire de site ne part jamais dans le jeu d'entraînement.
      const result = await Promise.race([
        client.scan(text.slice(0, 2000), false),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), AEGIS_TIMEOUT_MS)),
      ]);
      if (result && result.toxicity * 100 >= config.reviewThreshold) {
        return { allowed: false, reason: `toxicity:${Math.round(result.toxicity * 100)}` };
      }
    } catch (err) {
      logger.warn('SiteModeration', `AegisAI indisponible pour ${guildId}, texte accepté sans score :`, err);
    }
  }
  return { allowed: true, reason: null };
}

/** Toutes les URL d'un document (liens, boutons, images, blocs de partenaires). */
function documentUrls(doc: SiteDocument): string[] {
  const urls: string[] = [];
  const visit = (node: SiteNode) => {
    const a = node.attrs ?? {};
    if (typeof a.href === 'string') urls.push(a.href);
    if (typeof a.src === 'string') urls.push(a.src);
    for (const mark of node.marks ?? []) if (typeof mark.attrs?.href === 'string') urls.push(mark.attrs.href);
    if (node.type === 'module' && Array.isArray((a.config as { items?: unknown })?.items)) {
      for (const item of (a.config as { items: Array<{ url?: string; logoUrl?: string }> }).items) {
        if (item.url) urls.push(item.url);
        if (item.logoUrl) urls.push(item.logoUrl);
      }
    }
    for (const child of node.content ?? []) visit(child);
  };
  for (const node of doc.content) visit(node);
  return urls;
}

/**
 * Domaine d'arnaque connu présent dans une page, ou nul. Appelé à la
 * publication : une page qui renvoie vers une arnaque connue n'est pas mise
 * en ligne, quel que soit son auteur.
 */
export async function findScamInDocument(guildId: string, doc: SiteDocument): Promise<string | null> {
  const text = `${extractSiteDocumentText(doc)}\n${documentUrls(doc).join('\n')}`;
  return findKnownScamDomain(guildId, text).catch(() => null);
}
