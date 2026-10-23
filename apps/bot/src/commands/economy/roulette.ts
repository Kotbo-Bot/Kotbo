import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import prisma from '../../utils/db.js';
import { getOrCreateRpgProfile, getOrCreateEconomyConfig, registerGambleAttempt, takeBet, creditBalance } from '../../services/features/economyService.js';
import { errorEmbed, COLORS } from '../../utils/embeds.js';
import { getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { publicErrorMessage } from '../../utils/publicError.js';

const meta = getCommandMetadata('b3_roulette');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addIntegerOption(option =>
    option
      .setName('mise')
      .setDescription(m.b3_roulette_opt_mise({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.b3_roulette_opt_mise({}, { locale: 'fr' }) })
      .setRequired(true)
      .setMinValue(1)
  );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;
  const bet = interaction.options.getInteger('mise', true);

  try {
    const config = await getOrCreateEconomyConfig(guildId);
    if (!config.enabled) {
      await interaction.reply({
        embeds: [errorEmbed('Module Désactivé', "Le système d'économie est désactivé sur ce serveur.")],
        flags: [MessageFlags.Ephemeral]
      });
      return;
    }

    const profile = await getOrCreateRpgProfile(guildId, userId);
    if (profile.balance < bet) {
      await interaction.reply({
        embeds: [errorEmbed('Solde insuffisant', `Vous n'avez pas assez de pièces pour parier **${bet}** 🪙 (Solde actuel : **${profile.balance}** 🪙).`)],
        flags: [MessageFlags.Ephemeral]
      });
      return;
    }

    if (profile.health <= 0) {
      await interaction.reply({
        embeds: [errorEmbed('Hors service', "Vous n'avez plus aucun point de vie (0 PV). Soignez-vous avec des potions avant de retenter votre chance !")],
        flags: [MessageFlags.Ephemeral]
      });
      return;
    }

    await registerGambleAttempt(guildId, userId, bet);

    // Mise prise d'avance par une écriture conditionnelle, gain versé par incrément : voir takeBet.
    if (!(await takeBet(profile.id, bet))) {
      await interaction.reply({
        embeds: [errorEmbed('Solde insuffisant', `Vous n'avez plus assez de pièces pour parier **${bet}** 🪙.`)],
        flags: [MessageFlags.Ephemeral]
      });
      return;
    }

    // Roll chamber (1 to 6)
    const firedChamber = 1;
    const rolledChamber = Math.floor(Math.random() * 6) + 1;

    const isShot = rolledChamber === firedChamber;
    let netGain = 0;
    let newHp = profile.health;
    let resultMessage = '';
    let embedColor = COLORS.success;

    if (isShot) {
      netGain = -bet;
      newHp = Math.max(0, profile.health - 50);
      resultMessage = `💥 **PAN ! Le coup part ! Vous perdez votre mise et perdez 50 PV...**`;
      embedColor = COLORS.danger;
    } else {
      // Survives: wins 1.2x their bet (20% gain)
      netGain = Math.floor(bet * 1.2) - bet;
      resultMessage = `🔫 *Clic... La chambre était vide. Vous survivez de justesse !*`;
      embedColor = COLORS.success;
    }

    const newBalance = await creditBalance(profile.id, bet + netGain);

    // Les PV aussi s'écrivent sans repartir d'une lecture périmée : une potion bue pendant
    // la partie n'est pas effacée. Un reste inférieur aux dégâts tombe à zéro.
    if (isShot) {
      const hurt = await prisma.rpgProfile.updateMany({
        where: { id: profile.id, health: { gte: 50 } },
        data: { health: { decrement: 50 } },
      });
      if (hurt.count === 0) {
        await prisma.rpgProfile.updateMany({ where: { id: profile.id, health: { lt: 50 } }, data: { health: 0 } });
      }
    }

    const embed = new EmbedBuilder()
      .setTitle('🔫 Roulette Russe')
      .setDescription(
        `Vous placez le canon sur votre tempe et pressez la détente avec une mise de **${bet}** ${config.currencyEmoji}...\n\n` +
        `**Chambre testée :** ${rolledChamber}/6\n\n` +
        `${resultMessage}\n\n` +
        `**Gain net :** **${netGain >= 0 ? '+' : ''}${netGain}** ${config.currencyEmoji}\n` +
        `**Nouveau solde :** **${newBalance}** ${config.currencyEmoji}\n` +
        `**Vos PV restants :** **${newHp}** / ${profile.maxHealth} ❤️`
      )
      .setColor(embedColor)
      .setTimestamp();

    if (newHp <= 0 && isShot) {
      embed.addFields({ name: '💀 K.O.', value: 'Vous êtes tombé à 0 PV. Vous devez attendre que vos PV se restaurent passivement ou boire une potion de vie.' });
    }

    await interaction.reply({ embeds: [embed] });
  } catch (err: unknown) {
    await interaction.reply({
      embeds: [errorEmbed('Erreur', publicErrorMessage(err, 'Impossible de jouer à la roulette.'))],
      flags: [MessageFlags.Ephemeral]
    });
  }
}

export const rouletteCommand = { data, execute } satisfies SlashCommandDefinition;
