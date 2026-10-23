import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import {
  getRichestPlayers,
  getTopByLevel,
  getTopByMonstersKilled,
  getTopByFishCaught,
  getTopByItems,
  getOrCreateEconomyConfig,
} from '../../services/features/economyService.js';
import { errorEmbed, COLORS } from '../../utils/embeds.js';
import prisma from '../../utils/db.js';
import { getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { publicErrorMessage } from '../../utils/publicError.js';

const meta = getCommandMetadata('c5_top');

const choice = (key: 'argent' | 'rpg' | 'items' | 'monstres' | 'peche') => ({
  name: (m as any)[`c5_top_choice_${key}`]({}, { locale: 'en' }) as string,
  name_localizations: { fr: (m as any)[`c5_top_choice_${key}`]({}, { locale: 'fr' }) as string },
  value: key,
});

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addStringOption(option =>
    option
      .setName('type')
      .setDescription(m.c5_top_opt_type({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c5_top_opt_type({}, { locale: 'fr' }) })
      .setRequired(true)
      .addChoices(
        choice('argent'),
        choice('rpg'),
        choice('items'),
        choice('monstres'),
        choice('peche'),
      ),
  );

/**
 * Meilleur étage de la Tour de chaque joueur, quand la Tour est active sur le serveur : il
 * s'ajoute aux lignes des classements RPG. `null` : Tour éteinte, rien à afficher.
 */
async function towerFloors(guildId: string, userIds: string[]): Promise<Map<string, number> | null> {
  const tower = await prisma.rpgTowerConfig.findUnique({ where: { guildId }, select: { enabled: true } });
  if (!tower?.enabled || userIds.length === 0) return null;
  const profiles = await prisma.rpgTowerProfile.findMany({
    where: { guildId, userId: { in: userIds } },
    select: { userId: true, bestFloorAllTime: true },
  });
  return new Map(profiles.map((profile) => [profile.userId, profile.bestFloorAllTime]));
}

function towerSuffix(floors: Map<string, number> | null, userId: string): string {
  return floors ? ` | étage max ${floors.get(userId) ?? 0}` : '';
}

function medal(index: number): string {
  if (index === 0) return '🥇';
  if (index === 1) return '🥈';
  if (index === 2) return '🥉';
  return `\`#${index + 1}\``;
}

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: 'Cette commande doit être utilisée dans un serveur.', flags: [MessageFlags.Ephemeral] });
    return;
  }

  await interaction.deferReply();

  const type = interaction.options.getString('type', true);
  const config = await getOrCreateEconomyConfig(guildId);

  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTimestamp()
    .setFooter({ text: `${interaction.guild?.name ?? 'Serveur'}` });

  try {
    if (type === 'argent') {
      const players = await getRichestPlayers(guildId, 10);
      if (players.length === 0) {
        await interaction.editReply({ embeds: [errorEmbed('Classement vide', 'Personne n\'a encore de pièces.')] });
        return;
      }
      embed.setTitle(`💰 Top Argent - ${interaction.guild?.name ?? ''}`);
      embed.setDescription(
        players.map((p, i) =>
          `${medal(i)} <@${p.userId}> - **${p.balance.toLocaleString('fr-FR')}** ${config.currencyEmoji} (Niv. ${p.level})`
        ).join('\n')
      );

    } else if (type === 'rpg') {
      const players = await getTopByLevel(guildId, 10);
      if (players.length === 0) {
        await interaction.editReply({ embeds: [errorEmbed('Classement vide', 'Personne n\'a encore de profil RPG.')] });
        return;
      }
      embed.setTitle(`⭐ Top RPG - ${interaction.guild?.name ?? ''}`);
      const floors = await towerFloors(guildId, players.map((p) => p.userId));
      embed.setDescription(
        players.map((p, i) => {
          const xpNeeded = p.level * 100;
          return `${medal(i)} <@${p.userId}> - **Niveau ${p.level}** (${p.xp}/${xpNeeded} XP) | ⚔️ ${p.attack} 🛡️ ${p.defense}${towerSuffix(floors, p.userId)}`;
        }).join('\n')
      );

    } else if (type === 'items') {
      const players = await getTopByItems(guildId, 10);
      if (players.length === 0) {
        await interaction.editReply({ embeds: [errorEmbed('Classement vide', 'Personne n\'a encore d\'objets.')] });
        return;
      }
      embed.setTitle(`🎒 Top Items - ${interaction.guild?.name ?? ''}`);
      embed.setDescription(
        players.map((p, i) =>
          `${medal(i)} <@${p.userId}> - **${p.totalItems}** objets (Niv. ${p.level})`
        ).join('\n')
      );

    } else if (type === 'monstres') {
      const players = await getTopByMonstersKilled(guildId, 10);
      if (players.length === 0) {
        await interaction.editReply({ embeds: [errorEmbed('Classement vide', 'Personne n\'a encore tué de monstre.')] });
        return;
      }
      embed.setTitle(`⚔️ Top Monstres - ${interaction.guild?.name ?? ''}`);
      const floors = await towerFloors(guildId, players.map((p) => p.userId));
      embed.setDescription(
        players.map((p, i) =>
          `${medal(i)} <@${p.userId}> - **${p.totalMonstersKilled}** monstres tués | 👑 ${p.totalBossesKilled} boss (Niv. ${p.level})${towerSuffix(floors, p.userId)}`
        ).join('\n')
      );

    } else if (type === 'peche') {
      const players = await getTopByFishCaught(guildId, 10);
      if (players.length === 0) {
        await interaction.editReply({ embeds: [errorEmbed('Classement vide', 'Personne n\'a encore pêché.')] });
        return;
      }
      embed.setTitle(`🎣 Top Pêche - ${interaction.guild?.name ?? ''}`);
      embed.setDescription(
        players.map((p, i) =>
          `${medal(i)} <@${p.userId}> - **${p.totalFishCaught}** poissons pêchés (Niv. ${p.level})`
        ).join('\n')
      );
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (err: unknown) {
    const errMsg = publicErrorMessage(err, 'Impossible de charger le classement.');
    await interaction.editReply({ embeds: [errorEmbed('Erreur', errMsg)] });
  }
}

export const topCommand = { data, execute } satisfies SlashCommandDefinition;
