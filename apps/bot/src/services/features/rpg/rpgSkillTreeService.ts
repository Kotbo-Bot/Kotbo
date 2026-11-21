/**
 * Progression dans l'arbre de compétences.
 *
 * Le catalogue (`rpgSkillTree.ts`) est statique ; seul l'achat vit en base. Ce service
 * est la seule porte d'entrée en écriture : il vérifie le niveau, les prérequis, le rang
 * et le solde de points dans la MÊME transaction que l'achat, pour qu'un double clic ne
 * puisse pas acheter deux fois le même rang avec un seul point.
 */

import prisma from '../../../utils/db.js';
import { getRpgClass, type RpgSkill } from './rpgClasses.js';
import {
  RESPEC_COST,
  SKILL_TREE_UNLOCK_LEVEL,
  aggregateNodeBonuses,
  getSkillNode,
  nodesForClass,
  pointsSpent,
  skillsFromNodes,
  type SkillNode,
  type SkillNodeBonus,
} from './rpgSkillTree.js';

export type SkillUnlock = { nodeId: string; rank: number };

/** Un nœud tel que le joueur le voit : son rang, et ce qui lui manque pour l'acheter. */
export type SkillNodeView = {
  node: SkillNode;
  rank: number;
  maxed: boolean;
  /** `true` quand le nœud peut être acheté immédiatement. */
  affordable: boolean;
  /** Raison du refus, à afficher. `null` quand le nœud est achetable. */
  blockedBy: 'level' | 'requires' | 'points' | 'maxed' | null;
};

export type SkillTreeState = {
  /** `false` tant que le personnage n'a pas de classe : l'arbre n'a alors aucune branche. */
  open: boolean;
  className: string | null;
  level: number;
  points: number;
  spent: number;
  balance: number;
  respecCost: number;
  branches: { name: string; nodes: SkillNodeView[] }[];
  bonuses: Required<SkillNodeBonus>;
  skills: RpgSkill[];
};

/** Bonus et compétences accordés par l'arbre d'un profil. Lecture seule, sans état de vue. */
export async function loadSkillTreeEffects(rpgProfileId: string): Promise<{
  bonuses: Required<SkillNodeBonus>;
  skills: RpgSkill[];
}> {
  const unlocks = await prisma.rpgSkillUnlock.findMany({
    where: { rpgProfileId },
    select: { nodeId: true, rank: true },
  });

  return { bonuses: aggregateNodeBonuses(unlocks), skills: skillsFromNodes(unlocks) };
}

/** Les prérequis sont satisfaits quand chacun est possédé AU RANG MAXIMUM. */
function requirementsMet(node: SkillNode, rankByNode: Map<string, number>): boolean {
  return node.requires.every((requiredId) => {
    const required = getSkillNode(requiredId);
    // Un prérequis absent du catalogue ne doit pas verrouiller la branche à vie : le
    // nœud a été retiré d'une version à l'autre, la contrainte disparaît avec lui.
    if (!required) return true;
    return (rankByNode.get(requiredId) ?? 0) >= required.maxRank;
  });
}

function viewFor(node: SkillNode, rankByNode: Map<string, number>, level: number, points: number): SkillNodeView {
  const rank = rankByNode.get(node.id) ?? 0;
  const maxed = rank >= node.maxRank;

  // L'ordre des refus est celui qui aide : « il vous manque un niveau » avant « il vous
  // manque un point », parce que le second se règle tout seul en jouant.
  let blockedBy: SkillNodeView['blockedBy'] = null;
  if (maxed) blockedBy = 'maxed';
  else if (level < node.levelRequired) blockedBy = 'level';
  else if (!requirementsMet(node, rankByNode)) blockedBy = 'requires';
  else if (points < node.cost) blockedBy = 'points';

  return { node, rank, maxed, affordable: blockedBy === null, blockedBy };
}

export async function getSkillTreeState(guildId: string, userId: string): Promise<SkillTreeState> {
  const profile = await prisma.rpgProfile.findUnique({
    where: { guildId_userId: { guildId, userId } },
    include: { skillUnlocks: { select: { nodeId: true, rank: true } } },
  });

  if (!profile) throw new Error('Profil RPG introuvable.');

  const rpgClass = getRpgClass(profile.className);
  const unlocks: SkillUnlock[] = profile.skillUnlocks;
  const rankByNode = new Map(unlocks.map((unlock) => [unlock.nodeId, unlock.rank]));

  const base = {
    open: false,
    className: profile.className,
    level: profile.level,
    points: profile.skillPoints,
    spent: pointsSpent(unlocks),
    balance: profile.balance,
    respecCost: RESPEC_COST,
    bonuses: aggregateNodeBonuses(unlocks),
    skills: skillsFromNodes(unlocks),
  };

  if (!rpgClass || profile.level < SKILL_TREE_UNLOCK_LEVEL) {
    return { ...base, branches: [] };
  }

  const branches = new Map<string, SkillNodeView[]>();
  for (const node of nodesForClass(rpgClass.id)) {
    const view = viewFor(node, rankByNode, profile.level, profile.skillPoints);
    const list = branches.get(node.branch);
    if (list) list.push(view);
    else branches.set(node.branch, [view]);
  }

  return {
    ...base,
    open: true,
    branches: [...branches].map(([name, nodes]) => ({ name, nodes })),
  };
}

export type UnlockResult = { node: SkillNode; newRank: number; remainingPoints: number };

/**
 * Achète un rang sur un nœud.
 *
 * Toutes les vérifications sont refaites ici : l'écran d'où vient le clic peut dater de
 * plusieurs minutes, et le joueur a pu dépenser ses points ailleurs entre-temps.
 */
export async function unlockSkillNode(guildId: string, userId: string, nodeId: string): Promise<UnlockResult> {
  const node = getSkillNode(nodeId);
  if (!node) throw new Error('Compétence inconnue.');

  return prisma.$transaction(async (tx) => {
    const profile = await tx.rpgProfile.findUnique({
      where: { guildId_userId: { guildId, userId } },
      include: { skillUnlocks: { select: { nodeId: true, rank: true } } },
    });
    if (!profile) throw new Error('Profil RPG introuvable.');

    const rpgClass = getRpgClass(profile.className);
    if (!rpgClass) {
      throw new Error(`L'arbre de compétences s'ouvre avec le choix de classe, au niveau ${SKILL_TREE_UNLOCK_LEVEL}.`);
    }
    if (node.classId !== rpgClass.id) {
      throw new Error(`${node.name} appartient à une autre classe.`);
    }
    if (profile.level < node.levelRequired) {
      throw new Error(`${node.name} demande le niveau ${node.levelRequired}. Vous êtes niveau ${profile.level}.`);
    }

    const rankByNode = new Map(profile.skillUnlocks.map((unlock) => [unlock.nodeId, unlock.rank]));
    const currentRank = rankByNode.get(node.id) ?? 0;

    if (currentRank >= node.maxRank) {
      throw new Error(`${node.name} est déjà au rang maximum (${node.maxRank}).`);
    }
    if (!requirementsMet(node, rankByNode)) {
      const missing = node.requires
        .map((id) => getSkillNode(id)?.name)
        .filter((name): name is string => Boolean(name));
      throw new Error(`${node.name} demande d'abord : ${missing.join(', ')}.`);
    }
    if (profile.skillPoints < node.cost) {
      throw new Error(`Il vous faut ${node.cost} point(s) de compétence. Vous en avez ${profile.skillPoints}.`);
    }

    // Le débit est conditionné au solde dans le WHERE : deux clics simultanés ne peuvent
    // pas passer tous les deux, le second ne trouve plus de ligne à mettre à jour.
    const debited = await tx.rpgProfile.updateMany({
      where: { id: profile.id, skillPoints: { gte: node.cost } },
      data: { skillPoints: { decrement: node.cost } },
    });
    if (debited.count === 0) {
      throw new Error('Points de compétence insuffisants.');
    }

    const newRank = currentRank + 1;
    await tx.rpgSkillUnlock.upsert({
      where: { rpgProfileId_nodeId: { rpgProfileId: profile.id, nodeId: node.id } },
      create: { rpgProfileId: profile.id, nodeId: node.id, rank: newRank },
      update: { rank: newRank },
    });

    return { node, newRank, remainingPoints: profile.skillPoints - node.cost };
  });
}

export type RespecResult = { refunded: number; cost: number; newBalance: number };

/**
 * Remet l'arbre à zéro contre des pièces, et rend tous les points investis.
 *
 * Le coût est en pièces et non en points : faire payer la remise à zéro en points la
 * rendrait inaccessible précisément à ceux qui se sont trompés et n'ont plus rien.
 */
export async function respecSkillTree(guildId: string, userId: string): Promise<RespecResult> {
  return prisma.$transaction(async (tx) => {
    const profile = await tx.rpgProfile.findUnique({
      where: { guildId_userId: { guildId, userId } },
      include: { skillUnlocks: { select: { nodeId: true, rank: true } } },
    });
    if (!profile) throw new Error('Profil RPG introuvable.');

    if (profile.skillUnlocks.length === 0) {
      throw new Error("Votre arbre de compétences est déjà vierge.");
    }

    const refunded = pointsSpent(profile.skillUnlocks);

    const paid = await tx.rpgProfile.updateMany({
      where: { id: profile.id, balance: { gte: RESPEC_COST } },
      data: { balance: { decrement: RESPEC_COST }, skillPoints: { increment: refunded } },
    });
    if (paid.count === 0) {
      throw new Error(`La remise à zéro coûte ${RESPEC_COST} pièces. Vous en avez ${profile.balance}.`);
    }

    await tx.rpgSkillUnlock.deleteMany({ where: { rpgProfileId: profile.id } });

    return { refunded, cost: RESPEC_COST, newBalance: profile.balance - RESPEC_COST };
  });
}

/**
 * Efface l'arbre et rend les points, sans frais.
 *
 * Appelé au changement de classe : les branches sont propres à une classe, garder les
 * nœuds de l'ancienne laisserait des bonus que le nouvel arbre ne sait plus expliquer.
 */
export async function resetSkillTreeForClassChange(rpgProfileId: string): Promise<number> {
  const unlocks = await prisma.rpgSkillUnlock.findMany({
    where: { rpgProfileId },
    select: { nodeId: true, rank: true },
  });
  if (unlocks.length === 0) return 0;

  const refunded = pointsSpent(unlocks);
  await prisma.$transaction([
    prisma.rpgSkillUnlock.deleteMany({ where: { rpgProfileId } }),
    prisma.rpgProfile.update({
      where: { id: rpgProfileId },
      data: { skillPoints: { increment: refunded } },
    }),
  ]);

  return refunded;
}
