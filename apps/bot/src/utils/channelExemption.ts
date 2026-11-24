/**
 * Exemptions de salons qui acceptent aussi des catégories (#778).
 *
 * Les salons de tickets ou de partenariats naissent à la volée : on ne peut pas
 * les exempter un par un. Une liste d'exemptions peut donc contenir l'id d'une
 * catégorie, qui couvre tous ses salons et les fils de ces salons. L'AutoMod
 * native de Discord accepte déjà des catégories dans `exempt_channels` ; les
 * contrôles faits par le bot suivent la même règle.
 */

/**
 * Le strict nécessaire d'un salon discord.js pour remonter à sa catégorie.
 * `parentId` est facultatif : un salon de MP n'en a pas, il n'est alors
 * couvert que par son propre id.
 */
export interface ScopedChannel {
  id: string;
  parentId?: string | null;
  parent?: { parentId?: string | null } | null;
}

/** Ids couverts par une exemption : le salon, son parent, puis la catégorie de ce parent (cas d'un fil). */
export function channelScope(channel: ScopedChannel | null | undefined): string[] {
  if (!channel) return [];
  const ids = [channel.id, channel.parentId, channel.parent?.parentId];
  return ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

export function isChannelExempt(channel: ScopedChannel | null | undefined, exemptIds: readonly string[]): boolean {
  if (exemptIds.length === 0) return false;
  return channelScope(channel).some((id) => exemptIds.includes(id));
}
