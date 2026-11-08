import type { Prisma } from '@prisma/client';
import { MODULE_REGISTRY, isModulePaused } from '@kotbo/contracts';
import prisma from '../../utils/db.js';
import { getDeclaredModuleStates } from './moduleGate.js';

/**
 * Lignes de configuration creees a la premiere ouverture du Centre de gestion.
 *
 * La liste etait tenue a la main ici, a cote de `MODULE_REGISTRY`. Les deux ont
 * derive : douze modules du registre n'avaient aucune ligne, donc aucune
 * permission a distribuer et aucune entree dans le Centre de gestion, alors
 * que le bot les executait. Le registre fait foi ; ajouter un module suffit
 * desormais a l'y faire apparaitre.
 *
 * `content` n'est pas un module : c'est une clef historique dont des serveurs
 * portent encore la ligne en base. Elle reste declaree pour que sa categorie et
 * son libelle continuent d'etre connus, au lieu de tomber dans « Autre ».
 */
const LEGACY_FEATURES = [
  {
    featureKey: 'content',
    featureName: 'Contenu',
    description: 'Gestion du contenu et messages',
    category: 'moderation',
  },
];

export const defaultFeatures = [
  ...MODULE_REGISTRY.map((mod) => ({
    featureKey: mod.key,
    featureName: mod.name,
    description: mod.description,
    category: mod.category,
  })),
  ...LEGACY_FEATURES,
];

/**
 * Configurations que l'on montre ou laisse regler : celles des modules en pause
 * restent en base (et dans `getOrCreateFeatureConfigs`, dont dependent les
 * droits), mais sortent du dashboard et des outils MCP.
 */
export async function getAvailableFeatureConfigs(guildId: string) {
  const configs = await getOrCreateFeatureConfigs(guildId);
  return configs.filter((config) => !isModulePaused(config.featureKey));
}

export async function getOrCreateFeatureConfigs(guildId: string) {
  // 1. Fetch all existing configs with their relations first
  const existingConfigs = await prisma.dashboardFeatureConfig.findMany({
    where: { guildId },
    include: {
      roleAccess: {
        orderBy: { staffRoleLevel: 'asc' },
      },
      roleAccessByRole: {
        orderBy: { roleId: 'asc' },
      },
      notificationTargets: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  const existingKeys = new Set(existingConfigs.map(c => c.featureKey));
  const missingFeatures = defaultFeatures.filter(f => !existingKeys.has(f.featureKey));

  // 2. If none missing, return them immediately (saves a redundant findMany)
  if (missingFeatures.length === 0) {
    return existingConfigs;
  }

  // La ligne cree ici devient l'etat qui fait foi pour la garde de lecture :
  // l'ecrire a `true` allumait, a la premiere ouverture du Centre de gestion,
  // tous les modules qui demarrent eteints - niveaux, economie, Daily Algo,
  // auto-thread... On reprend donc l'etat deja declare ailleurs (table propre au
  // module, colonne historique, defaut du registre). L'offre commerciale et la
  // cascade des dependances restent hors de cette valeur : elles s'appliquent a
  // la lecture, et les figer ici gelerait l'offre du jour dans la base.
  const declaredStates = await getDeclaredModuleStates(guildId).catch(() => ({} as Record<string, boolean>));

  // 3. Initialize missing features in parallel
  //
  // Plusieurs requetes du dashboard tombent ici en meme temps sur une guilde a
  // qui il manque des lignes : le chargement de l etat et l appel de la page
  // ouverte partent ensemble, voient les memes fonctionnalites absentes et les
  // creent toutes les deux. La violation d unicite qui en resulte ne signale
  // pas une erreur, seulement que l autre requete a gagne la course.
  await Promise.all(missingFeatures.map(async (feature) => {
    try {
      await prisma.dashboardFeatureConfig.create({
        data: {
          guildId,
          featureKey: feature.featureKey,
          featureName: feature.featureName,
          enabled: declaredStates[feature.featureKey] ?? true,
          loggingEnabled: true,
          userActivityTracking: true,
          notifyViaDiscordChannel: true,
          notifyViaDM: false,
          roleAccess: {
            create: [
              { guildId, staffRoleLevel: 0, canView: true },
              { guildId, staffRoleLevel: 1, canView: true, canModerate: true },
              { guildId, staffRoleLevel: 2, canView: true, canModerate: true, canConfigure: true, canDelete: true },
            ],
          },
        },
      });
    } catch (err) {
      if ((err as { code?: string })?.code !== 'P2002') throw err;
    }
  }));

  // 4. Fetch again to return everything (only happens once when missing)
  return prisma.dashboardFeatureConfig.findMany({
    where: { guildId },
    include: {
      roleAccess: { orderBy: { staffRoleLevel: 'asc' } },
      roleAccessByRole: { orderBy: { roleId: 'asc' } },
      notificationTargets: true,
    },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Configuration d'une fonctionnalite - jamais son activation. `enabled` n'y
 * figure pas : l'ecrire ici changeait la colonne sans propager la cascade des
 * dependances, sans verifier l'offre, sans toucher la table propre au module et
 * sans purger le cache d'etats. Voir `setDashboardModuleStatus`.
 */
export async function updateFeatureConfig(
  guildId: string,
  featureKey: string,
  data: {
    channelId?: string | null;
    secondaryChannelId?: string | null;
    requiredRoleId?: string | null;
    notificationRoleId?: string | null;
    notifyViaDiscordChannel?: boolean;
    notifyViaDM?: boolean;
    loggingEnabled?: boolean;
    userActivityTracking?: boolean;
    metadata?: Record<string, unknown>;
  }
) {
  return prisma.dashboardFeatureConfig.update({
    where: {
      guildId_featureKey: { guildId, featureKey },
    },
    data: {
      ...data,
      metadata: data.metadata ? (data.metadata as Prisma.InputJsonValue) : undefined,
    },
    include: {
      roleAccess: true,
      notificationTargets: true,
    },
  });
}

export async function updateRoleAccess(
  guildId: string,
  featureConfigId: string,
  roleAccessConfigs: Array<{
    roleId: string;
    canView?: boolean;
    canModerate?: boolean;
    canConfigure?: boolean;
    canDelete?: boolean;
  }>
) {
  // Le vidage et la reecriture dans une seule transaction : separes, une
  // creation qui echoue laissait la fonctionnalite sans aucune regle, donc
  // ouverte a tout le staff, et rien ne disait que la matrice venait d'etre
  // perdue. C'est l'endroit ou un etat intermediaire coute le plus cher.
  await prisma.$transaction([
    prisma.dashboardFeatureRoleAccess.deleteMany({ where: { featureConfigId } }),
    ...roleAccessConfigs.map((config) =>
      prisma.dashboardFeatureRoleAccess.create({
        data: {
          guildId,
          featureConfigId,
          roleId: config.roleId,
          canView: config.canView ?? false,
          canModerate: config.canModerate ?? false,
          canConfigure: config.canConfigure ?? false,
          canDelete: config.canDelete ?? false,
        },
      })
    ),
  ]);

  return prisma.dashboardFeatureConfig.findUnique({
    where: { id: featureConfigId },
    include: {
      roleAccess: { orderBy: { staffRoleLevel: 'asc' } },
      roleAccessByRole: { orderBy: { roleId: 'asc' } },
      notificationTargets: true,
    },
  });
}

export async function applyPresetToFeatureAccess(
  guildId: string,
  presetKey: 'general' | 'gaming' | 'dev',
  roleIds: { adminRoleIds: string[]; modRoleIds: string[] }
) {
  const configs = await getOrCreateFeatureConfigs(guildId);
  
  const updates = configs.map(async (config) => {
    const featureKey = config.featureKey;
    
    // Clear existing per-role access for this feature to avoid conflicts
    await prisma.dashboardFeatureRoleAccess.deleteMany({
      where: { featureConfigId: config.id }
    });

    const roleAccessToCreate = [];

    // Default mapping based on preset
    for (const adminId of roleIds.adminRoleIds) {
      roleAccessToCreate.push({
        guildId,
        featureConfigId: config.id,
        roleId: adminId,
        canView: true,
        canModerate: true,
        canConfigure: true,
        canDelete: true
      });
    }

    for (const modId of roleIds.modRoleIds) {
      // Don't add if already added as admin
      if (roleIds.adminRoleIds.includes(modId)) continue;

      const isRestricted = ['settings', 'commands', 'discipline'].includes(featureKey);
      
      roleAccessToCreate.push({
        guildId,
        featureConfigId: config.id,
        roleId: modId,
        canView: true,
        canModerate: !isRestricted,
        canConfigure: false,
        canDelete: false
      });
    }

    if (roleAccessToCreate.length > 0) {
      await prisma.dashboardFeatureRoleAccess.createMany({
        data: roleAccessToCreate
      });
    }
  });

  await Promise.all(updates);
}
