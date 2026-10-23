/**
 * Modules qui demandent plus qu'un interrupteur pour servir a quelque chose.
 *
 * L'AutoMod n'a aucun effet tant qu'aucun filtre n'est arme : ses reglages sont
 * tous a `false` par defaut. L'allumer veut donc dire poser un prereglage, et
 * c'est le prereglage recommande - le meme objet que celui propose par la page
 * AutoMod, lu depuis `@kotbo/shared` - qui est applique ici.
 *
 * La sante des salons, elle, a besoin d'un salon ou deposer ses conseils.
 */
import { AUTOMOD_PRESETS, automodActiveFilterCount, type AutomodPreset } from '@kotbo/shared';
import type { Client } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { errorMessage } from '../../utils/errors.js';
import { publicErrorMessage } from '../../utils/publicError.js';

/** Le prereglage mis en avant par la page AutoMod, celui qui convient a un serveur qui debute. */
export function recommendedAutomodPreset(): AutomodPreset {
  const preset = AUTOMOD_PRESETS.find((entry) => entry.recommended) ?? AUTOMOD_PRESETS[0];
  if (!preset) throw new Error('Aucun prereglage AutoMod disponible.');
  return preset;
}

/**
 * Arme l'AutoMod sur le prereglage recommande.
 *
 * Seuls les filtres et les seuils du prereglage sont ecrits. L'anti-bot, le
 * verrou des permissions et la suspension par rafale n'y figurent pas et ne
 * sont pas touches : ces reglages-la sont reserves au proprietaire du serveur,
 * et un serveur qui les a deja armes doit les retrouver intacts.
 *
 * Rend l'avertissement a remonter, ou `null` si tout s'est bien passe.
 */
export async function applyRecommendedAutomod(client: Client, guildId: string): Promise<string | null> {
  const preset = recommendedAutomodPreset();

  const existingFilters = await prisma.autoModConfig.findUnique({ where: { guildId } });
  const existingRaid = await prisma.raidProtectionConfig.findUnique({ where: { guildId } });

  // Un seul filtre deja arme signe un AutoMod regle a la main : le prereglage
  // ne s'y substitue pas. La mise en place remplit ce qui est vide, elle ne
  // refait pas les choix de l'admin - meme regle que pour les textes de tickets
  // ou le message de montee de niveau.
  const alreadyArmed = automodActiveFilterCount(existingFilters ?? {}, existingRaid ?? {}) > 0;

  if (!alreadyArmed) {
    await prisma.autoModConfig.upsert({
      where: { guildId },
      create: { guildId, ...preset.filters },
      update: { ...preset.filters },
    });
    await prisma.raidProtectionConfig.upsert({
      where: { guildId },
      create: { guildId, ...preset.raid },
      update: { ...preset.raid },
    });
  }

  const { invalidateAutoModCache, syncDiscordAutoModRules } = await import('../moderation/autoModService.js');
  invalidateAutoModCache(guildId);

  // Les filtres du bot fonctionnent sans cette etape : elle ne fait que porter
  // les memes regles dans l'AutoMod natif de Discord, ce qui reclame « Gerer le
  // serveur ». Sans cette permission la synchronisation leve, et laisser
  // l'erreur remonter interromprait toute la mise en place pour un supplement.
  try {
    const config = await prisma.autoModConfig.findUnique({ where: { guildId } });
    if (config) await syncDiscordAutoModRules(client, guildId, config);
  } catch (err) {
    logger.warn('ModuleProvisioning', `Synchronisation AutoMod Discord impossible sur ${guildId} : ${errorMessage(err)}`);
    return publicErrorMessage(err);
  }

  return null;
}

/**
 * Allume la sante des salons en mode conseil, et lui donne le salon ou ecrire.
 * Sans salon d'alerte, elle analyse sans jamais rien dire.
 */
export async function enableChannelHealth(guildId: string, alertChannelId: string | null): Promise<void> {
  await prisma.channelHealthConfig.upsert({
    where: { guildId },
    create: { guildId, enabled: true, ...(alertChannelId ? { alertChannelId } : {}) },
    // Le salon n'ecrase celui deja choisi que s'il n'y en avait pas : la mise
    // en place ne redirige pas des alertes que l'admin avait dirigees ailleurs.
    update: { enabled: true },
  });

  if (alertChannelId) {
    await prisma.channelHealthConfig.updateMany({
      where: { guildId, alertChannelId: null },
      data: { alertChannelId },
    });
  }
}
