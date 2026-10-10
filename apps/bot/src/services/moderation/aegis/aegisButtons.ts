/**
 * Boutons des cartes AegisAI. Le droit de modérer est vérifié par
 * l'aiguilleur des interactions avant d'arriver ici.
 */
import { MessageFlags, type ButtonInteraction } from 'discord.js';
import { parseAegisButton } from './aegisAlerts.js';
import { confirmDetection, dismissDetection, unslowDetection } from './aegisActions.js';

const DONE: Record<string, string> = {
  confirm: '✅ Décision enregistrée.',
  dismiss: '✅ Faux positif enregistré, ce que le bot avait fait est défait.',
  unslow: '✅ Mode lent levé.',
};

export async function handleAegisButton(interaction: ButtonInteraction): Promise<void> {
  const route = parseAegisButton(interaction.customId);
  if (!route || !interaction.guild) return;
  // La décision peut prendre quelques secondes (sanction, retrait) : on
  // accuse réception tout de suite.
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  const actor = { id: interaction.user.id, tag: interaction.user.tag };
  const result =
    route.action === 'confirm'
      ? await confirmDetection(interaction.client, interaction.guild, route.detectionId, actor)
      : route.action === 'dismiss'
        ? await dismissDetection(interaction.guild, route.detectionId, actor)
        : await unslowDetection(interaction.guild, route.detectionId, actor);

  await interaction.editReply({ content: result.ok ? DONE[route.action]! : `❌ ${result.error}` });
}
