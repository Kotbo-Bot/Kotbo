import {
  MessageFlags,
  StringSelectMenuBuilder,
  type Guild,
  type GuildMember,
  type Message,
  type MessageContextMenuCommandInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type UserContextMenuCommandInteraction,
} from 'discord.js';
import { kotboContainer, truncate } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { actionRow, separator, v2Message } from '@arcscord/components';
import {
  buildActionModal,
  getAction,
  readModalInput,
  visibleActions,
  type ContextAction,
  type ContextActionScope,
} from './contextActionRegistry.js';
import { publicErrorMessage } from '../../utils/publicError.js';

/**
 * Hub des menus contextuels.
 *
 * Discord plafonne l'application à 5 entrées User et 5 Message au global. Une
 * seule entrée « hub » par scope ouvre donc un panneau éphémère listant toutes
 * les actions du registre auxquelles le membre a droit, ce qui rend le nombre
 * de features indépendant du quota Discord.
 */

// ─────────────────────────────────────────────────────────────
// Encodage de la cible dans le customId
//   user    → <userId>
//   message → <channelId>-<messageId>
// ─────────────────────────────────────────────────────────────

export function encodeTargetRef(scope: ContextActionScope, interaction: UserContextMenuCommandInteraction | MessageContextMenuCommandInteraction): string {
  if (scope === 'user') return interaction.targetId;
  const message = (interaction as MessageContextMenuCommandInteraction).targetMessage;
  return `${message.channelId}-${message.id}`;
}

function decodeMessageRef(targetRef: string): { channelId: string; messageId: string } | null {
  const [channelId, messageId] = targetRef.split('-');
  if (!channelId || !messageId) return null;
  return { channelId, messageId };
}

async function resolveMessage(guild: Guild, targetRef: string): Promise<Message<true> | null> {
  const ref = decodeMessageRef(targetRef);
  if (!ref) return null;

  const channel = await guild.channels.fetch(ref.channelId).catch(() => null);
  if (!channel?.isTextBased()) return null;

  const message = await channel.messages.fetch(ref.messageId).catch(() => null);
  return (message as Message<true> | null) ?? null;
}

// ─────────────────────────────────────────────────────────────
// Construction du panneau
// ─────────────────────────────────────────────────────────────

function groupByCategory(actions: ContextAction[]): Map<string, ContextAction[]> {
  const groups = new Map<string, ContextAction[]>();
  for (const action of actions) {
    const bucket = groups.get(action.category) ?? [];
    bucket.push(action);
    groups.set(action.category, bucket);
  }
  return groups;
}

export function buildHubPanel(params: {
  scope: ContextActionScope;
  invoker: GuildMember;
  targetRef: string;
  targetId: string;
  headline: string;
}): { components: ReturnType<typeof kotboContainer> } {
  const actions = visibleActions(params.scope, params.invoker, params.targetId);

  if (actions.length === 0) {
    return {
      components: kotboContainer({
        color: 'primary',
        title: '⚡ Actions Kotbo',
        fields: [
          params.headline,
          separator({ divider: true, spacing: 'small' }),
          "Aucune action n'est disponible pour toi sur cette cible.",
        ],
      }),
    };
  }

  // Discord plafonne un select à 25 options : le registre reste sous cette
  // limite, mais on tronque défensivement plutôt que de faire échouer l'envoi.
  const options = actions.slice(0, 25).map((action) => ({
    label: truncate(action.label, 100),
    value: action.id,
    description: truncate(`${action.category} · ${action.description}`, 100),
    emoji: action.emoji,
  }));

  const select = new StringSelectMenuBuilder()
    .setCustomId(`ctxhub:${params.scope}:${params.targetRef}`)
    .setPlaceholder('Choisis une action...')
    .addOptions(options);

  const categories = [...groupByCategory(actions).keys()];

  return {
    components: kotboContainer({
      color: 'primary',
      title: '⚡ Actions Kotbo',
      fields: [
        params.headline,
        separator({ divider: true, spacing: 'small' }),
        actionRow(select),
        separator({ divider: false, spacing: 'small' }),
        `-# ${actions.length} action(s) disponible(s) · ${categories.join(' · ')}`,
      ],
    }),
  };
}

// ─────────────────────────────────────────────────────────────
// Ouverture du hub depuis une entrée de menu contextuel
// ─────────────────────────────────────────────────────────────

export async function openUserHub(interaction: UserContextMenuCommandInteraction): Promise<void> {
  if (!interaction.inCachedGuild()) return;

  const targetRef = encodeTargetRef('user', interaction);
  const panel = buildHubPanel({
    scope: 'user',
    invoker: interaction.member,
    targetRef,
    targetId: interaction.targetId,
    headline: `Cible : <@${interaction.targetId}>`,
  });

  await interaction.reply(v2Message({ flags: MessageFlags.Ephemeral }, panel.components));
}

export async function openMessageHub(interaction: MessageContextMenuCommandInteraction): Promise<void> {
  if (!interaction.inCachedGuild()) return;

  const message = interaction.targetMessage;
  const targetRef = encodeTargetRef('message', interaction);
  const panel = buildHubPanel({
    scope: 'message',
    invoker: interaction.member,
    targetRef,
    targetId: message.author.id,
    headline: `Message de ${message.author} dans <#${message.channelId}>`,
  });

  await interaction.reply(v2Message({ flags: MessageFlags.Ephemeral }, panel.components));
}

// ─────────────────────────────────────────────────────────────
// Exécution
// ─────────────────────────────────────────────────────────────

/** Revalide la permission au moment de l'exécution : le panneau peut être resté ouvert après un changement de rôle. */
function assertAllowed(action: ContextAction, invoker: GuildMember, targetId: string): string | null {
  if (action.permission && !invoker.permissions.has(action.permission)) {
    return "Tu n'as pas la permission nécessaire pour cette action.";
  }
  if (action.allowSelf === false && invoker.id === targetId) {
    return 'Cette action ne peut pas être utilisée sur toi-même.';
  }
  return null;
}

async function runAndRender(params: {
  interaction: StringSelectMenuInteraction<'cached'> | ModalSubmitInteraction<'cached'>;
  action: ContextAction;
  targetRef: string;
  input: Record<string, string>;
}): Promise<void> {
  const { interaction, action, targetRef, input } = params;
  const guild = interaction.guild;
  const invoker = interaction.member;

  let result;
  try {
    if (action.scope === 'user') {
      const denial = assertAllowed(action, invoker, targetRef);
      if (denial) {
        await interaction.editReply(v2Message(denyContainer(denial)));
        return;
      }
      result = await action.run({ guild, invoker, targetId: targetRef }, input);
    } else {
      const message = await resolveMessage(guild, targetRef);
      if (!message) {
        await interaction.editReply(v2Message(denyContainer('Ce message est introuvable : il a probablement été supprimé.')));
        return;
      }

      const denial = assertAllowed(action, invoker, message.author.id);
      if (denial) {
        await interaction.editReply(v2Message(denyContainer(denial)));
        return;
      }
      result = await action.run({ guild, invoker, message }, input);
    }
  } catch (error) {
    logger.error('ContextHub', `Action "${action.scope}:${action.id}" en échec`, error);
    await interaction.editReply(v2Message(denyContainer(publicErrorMessage(error, 'Une erreur inattendue est survenue.'))));
    return;
  }

  await interaction.editReply(v2Message(result.container));
}

function denyContainer(reason: string) {
  return kotboContainer({ color: 'danger', title: '❌ Action impossible', fields: [reason] });
}

/** Route `ctxhub:<scope>:<targetRef>` - sélection d'une action dans le hub. */
export async function handleHubSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!interaction.inCachedGuild()) return;

  const [, scope, ...refParts] = interaction.customId.split(':');
  const targetRef = refParts.join(':');
  if (scope !== 'user' && scope !== 'message') return;

  const actionId = interaction.values[0];
  if (!actionId) return;

  const action = getAction(scope, actionId);
  if (!action) {
    await interaction.reply({ content: '❌ Action inconnue ou retirée.', flags: [MessageFlags.Ephemeral] });
    return;
  }

  // Un modal doit être présenté sans defer préalable.
  const modal = buildActionModal(action, targetRef);
  if (modal) {
    await interaction.showModal(modal);
    return;
  }

  await interaction.deferUpdate();
  await runAndRender({ interaction, action, targetRef, input: {} });
}

/** Route `ctxhub_modal:<scope>:<actionId>:<targetRef>` - soumission du modal d'une action. */
export async function handleHubModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.inCachedGuild()) return;

  const [, scope, actionId, ...refParts] = interaction.customId.split(':');
  const targetRef = refParts.join(':');
  if ((scope !== 'user' && scope !== 'message') || !actionId) return;

  const action = getAction(scope, actionId);
  if (!action) {
    await interaction.reply({ content: '❌ Action inconnue ou retirée.', flags: [MessageFlags.Ephemeral] });
    return;
  }

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  await runAndRender({ interaction, action, targetRef, input: readModalInput(action, interaction) });
}
