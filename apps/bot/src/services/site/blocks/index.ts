/**
 * Registre des blocs de modules et rendu d'une page entière.
 *
 * Chaque bloc est enveloppé dans une `<section class="mod">` qui porte son
 * repère (`data-block="<page>:<rang>"`). Le script du site s'en sert pour :
 * - recharger un bloc « en direct » à intervalle régulier (`data-live`) ;
 * - le recharger avec l'identité du visiteur une fois celui-ci connu
 *   (`data-viewer-aware`), puisque le rendu serveur ne la connaît jamais.
 *
 * Un bloc dont le module est éteint ne rend rien : le site n'affiche pas une
 * fonctionnalité que le serveur a fermée.
 */

import {
  getSiteModuleSpec,
  isSiteModuleKey,
  siteModuleBotDependency,
  type SiteDocument,
  type SiteModuleKey,
  type SiteNode,
} from '@kotbo/shared';
import { logger } from '../../../utils/logger.js';
import * as m from '../../../lib/paraglide/messages.js';
import { attrs } from '../siteHtml.js';
import { emptyState, type BlockContext, type BlockRef, type BlockRegistry } from './blockContext.js';
import { vitrineBlocks } from './vitrineBlocks.js';
import { discordBlocks } from './discordBlocks.js';
import { engagementBlocks } from './engagementBlocks.js';
import { demarchesBlocks } from './demarchesBlocks.js';
import { contentBlocks } from './contentBlocks.js';
import { memberBlocks } from './memberBlocks.js';
import { voteBlocks } from './voteBlocks.js';
import { shopBlocks } from './shopBlocks.js';

export type { BlockContext, BlockRef } from './blockContext.js';

const REGISTRY: BlockRegistry = {
  ...vitrineBlocks,
  ...discordBlocks,
  ...engagementBlocks,
  ...demarchesBlocks,
  ...contentBlocks,
  ...memberBlocks,
  ...voteBlocks,
  ...shopBlocks,
};

/** Fréquence de rafraîchissement des blocs en direct, en secondes. */
const LIVE_REFRESH_SECONDS: Partial<Record<SiteModuleKey, number>> = {
  members: 120,
  serverStats: 300,
  voice: 30,
  channelFeed: 60,
  giveaways: 120,
  ticket: 30,
};

export function isBlockAvailable(ctx: BlockContext, key: SiteModuleKey, config: Record<string, unknown>): boolean {
  const dependency = siteModuleBotDependency(key, config);
  return !dependency || ctx.moduleStates[dependency] !== false;
}

export async function renderBlock(ctx: BlockContext, key: SiteModuleKey, config: Record<string, unknown>, ref: BlockRef): Promise<string> {
  if (!isBlockAvailable(ctx, key, config)) return '';
  const renderer = REGISTRY[key];
  if (!renderer) return '';

  let inner: string;
  try {
    inner = await renderer(ctx, config, ref);
  } catch (err) {
    logger.warn('Site', `Bloc ${key} en échec sur ${ctx.site.guildId} :`, err);
    inner = emptyState(m.site_error_generic({}, { locale: ctx.locale }));
  }
  if (!inner) return '';

  const spec = getSiteModuleSpec(key);
  const refresh = LIVE_REFRESH_SECONDS[key];
  return `<section${attrs({
    class: `mod mod-${key}`,
    'data-block': `${ref.pageId}:${ref.index}`,
    'data-module': key,
    'data-live': spec.live && refresh ? refresh : null,
    'data-viewer-aware': spec.needsViewer || spec.interactive ? '1' : null,
  })}>${inner}</section>`;
}

/** Nœuds `module` d'un document, dans l'ordre où le rendu les rencontrera. */
export function collectModuleNodes(doc: SiteDocument): SiteNode[] {
  const nodes: SiteNode[] = [];
  const visit = (node: SiteNode) => {
    if (node.type === 'module') nodes.push(node);
    for (const child of node.content ?? []) visit(child);
  };
  for (const node of doc.content) visit(node);
  return nodes;
}

/** HTML de chaque bloc de modules d'un document, dans l'ordre du document. */
export async function renderDocumentBlocks(ctx: BlockContext, doc: SiteDocument, pageId: string): Promise<string[]> {
  const nodes = collectModuleNodes(doc);
  return Promise.all(
    nodes.map((node, index) => {
      const key = node.attrs?.module;
      if (!isSiteModuleKey(key)) return Promise.resolve('');
      const config = (node.attrs?.config ?? {}) as Record<string, unknown>;
      return renderBlock(ctx, key, config, { pageId, index });
    }),
  );
}

/** Bloc n°`index` d'un document, pour le rechargement d'un seul bloc. */
export function findModuleNode(doc: SiteDocument, index: number): { key: SiteModuleKey; config: Record<string, unknown> } | null {
  const node = collectModuleNodes(doc)[index];
  const key = node?.attrs?.module;
  if (!node || !isSiteModuleKey(key)) return null;
  return { key, config: (node.attrs?.config ?? {}) as Record<string, unknown> };
}
