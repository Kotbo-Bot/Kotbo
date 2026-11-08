import {
  ActionRowBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type Guild,
  type GuildMember,
  type Message,
  type ModalSubmitInteraction,
} from 'discord.js';
import { COLORS_RAW, kotboContainer, truncate } from '../../utils/embeds.js';
import { separator, v2Message } from '@arcscord/components';
import { publicErrorMessage } from '../../utils/publicError.js';

/**
 * Registre déclaratif des actions des menus contextuels.
 *
 * Discord plafonne une application à 5 menus contextuels User et 5 Message au
 * global. Plutôt que de brûler un slot par action, une entrée « hub » ouvre un
 * panneau qui liste les actions définies ici, filtrées selon les permissions de
 * celui qui clique.
 */

export type ContextActionScope = 'user' | 'message';

export type UserActionContext = {
  guild: Guild;
  invoker: GuildMember;
  targetId: string;
};

export type MessageActionContext = {
  guild: Guild;
  invoker: GuildMember;
  message: Message<true>;
};

export type ActionResult = {
  container: ReturnType<typeof kotboContainer>;
};

type BaseAction = {
  id: string;
  label: string;
  emoji: string;
  description: string;
  category: string;
  /** Permission requise pour voir et lancer l'action. Absente = ouverte à tous. */
  permission?: bigint;
  /** L'action a-t-elle un sens sur soi-même ? */
  allowSelf?: boolean;
  /** Champs du modal à afficher avant l'exécution. */
  modal?: {
    title: string;
    fields: {
      id: string;
      label: string;
      style: TextInputStyle;
      placeholder?: string;
      required?: boolean;
      maxLength?: number;
    }[];
  };
};

export type UserAction = BaseAction & {
  scope: 'user';
  run: (ctx: UserActionContext, input: Record<string, string>) => Promise<ActionResult>;
};

export type MessageAction = BaseAction & {
  scope: 'message';
  run: (ctx: MessageActionContext, input: Record<string, string>) => Promise<ActionResult>;
};

export type ContextAction = UserAction | MessageAction;

// ─────────────────────────────────────────────────────────────
// Helpers de rendu
// ─────────────────────────────────────────────────────────────

function panel(color: number, title: string, body: string): ActionResult {
  return { container: kotboContainer({ color, title, fields: [body] }) };
}

const ok = (title: string, body: string) => panel(COLORS_RAW.success, title, body);
const info = (title: string, body: string) => panel(COLORS_RAW.primary, title, body);
const warn = (title: string, body: string) => panel(COLORS_RAW.warning, title, body);
const fail = (title: string, body: string) => panel(COLORS_RAW.danger, title, body);

function messageLink(message: Message<true>): string {
  return `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
}

function messagePreview(message: Message<true>): string {
  const content = message.content?.trim();
  if (content) return truncate(content, 300);
  if (message.attachments.size > 0) return `*${message.attachments.size} pièce(s) jointe(s), aucun texte*`;
  if (message.embeds.length > 0) return '*Message composé uniquement d\'embeds*';
  return '*Message vide*';
}

// ─────────────────────────────────────────────────────────────
// Actions - clic droit sur un MESSAGE
// ─────────────────────────────────────────────────────────────

const messageActions: MessageAction[] = [
  {
    id: 'translate',
    scope: 'message',
    label: 'Traduire le message',
    emoji: '🌐',
    description: 'Traduit ce message en français',
    category: 'Utilitaire',
    async run(ctx) {
      const { isTranslationAvailable, translate } = await import('../integrations/translationService.js');
      if (!isTranslationAvailable()) {
        return fail('Traduction indisponible', "Aucun fournisseur de traduction n'est configuré sur cette instance.");
      }

      const source = ctx.message.content?.trim();
      if (!source) {
        return fail('Rien à traduire', 'Ce message ne contient pas de texte.');
      }

      const translated = await translate(source, 'fr');
      if (!translated) {
        return fail('Traduction échouée', "Le fournisseur n'a pas pu traduire ce message.");
      }

      return info('🌐 Traduction', `${translated}\n\n-# [Message d'origine](${messageLink(ctx.message)})`);
    },
  },
  {
    id: 'bookmark',
    scope: 'message',
    label: 'Sauvegarder en MP',
    emoji: '🔖',
    description: 'T\'envoie ce message en message privé',
    category: 'Utilitaire',
    async run(ctx) {
      const container = kotboContainer({
        color: 'primary',
        title: '🔖 Message sauvegardé',
        fields: [
          [
            `**Auteur** : ${ctx.message.author} (@${ctx.message.author.username})`,
            `**Salon** : <#${ctx.message.channelId}> · ${ctx.guild.name}`,
            `**Envoyé** : <t:${Math.floor(ctx.message.createdTimestamp / 1000)}:F>`,
          ].join('\n'),
          separator({ divider: true, spacing: 'small' }),
          messagePreview(ctx.message),
          `-# [Aller au message](${messageLink(ctx.message)})`,
        ],
      });

      try {
        await ctx.invoker.send(v2Message(container));
      } catch {
        return fail(
          'MP bloqué',
          'Impossible de t\'envoyer ce message en privé. Autorise les messages privés venant des membres de ce serveur, puis réessaie.',
        );
      }

      return ok('Sauvegardé', 'Le message t\'a été envoyé en MP.');
    },
  },
  {
    id: 'pin',
    scope: 'message',
    label: 'Épingler / désépingler',
    emoji: '📌',
    description: 'Bascule l\'épinglage de ce message',
    category: 'Utilitaire',
    permission: PermissionFlagsBits.ManageMessages,
    async run(ctx) {
      const wasPinned = ctx.message.pinned;
      try {
        if (wasPinned) await ctx.message.unpin();
        else await ctx.message.pin();
      } catch (error) {
        return fail(
          'Action impossible',
          publicErrorMessage(error, "Impossible de modifier l'épinglage de ce message."),
        );
      }

      return ok(
        wasPinned ? 'Message désépinglé' : 'Message épinglé',
        `[Le message](${messageLink(ctx.message)}) de ${ctx.message.author} a été ${wasPinned ? 'désépinglé' : 'épinglé'} dans <#${ctx.message.channelId}>.`,
      );
    },
  },
  {
    id: 'thread',
    scope: 'message',
    label: 'Créer un thread',
    emoji: '🧵',
    description: 'Ouvre un fil de discussion depuis ce message',
    category: 'Communauté',
    permission: PermissionFlagsBits.CreatePublicThreads,
    modal: {
      title: 'Créer un thread',
      fields: [
        {
          id: 'name',
          label: 'Nom du thread',
          style: TextInputStyle.Short,
          placeholder: 'Ex: Discussion sur le sujet',
          required: true,
          maxLength: 100,
        },
      ],
    },
    async run(ctx, input) {
      if (ctx.message.hasThread) {
        return warn('Thread déjà existant', `Ce message a déjà un fil : <#${ctx.message.thread?.id}>.`);
      }

      try {
        const thread = await ctx.message.startThread({
          name: truncate(input.name ?? 'Discussion', 100),
          reason: `Thread créé via menu contextuel par ${ctx.invoker.user.tag}`,
        });
        return ok('Thread créé', `Le fil <#${thread.id}> a été ouvert depuis [ce message](${messageLink(ctx.message)}).`);
      } catch (error) {
        return fail('Création impossible', publicErrorMessage(error, 'Impossible de créer le thread.'));
      }
    },
  },
  {
    id: 'doing_card',
    scope: 'message',
    label: 'Créer une carte de suivi',
    emoji: '📋',
    description: 'Ajoute ce message comme carte dans une liste de suivi',
    category: 'Staff',
    modal: {
      title: 'Carte de suivi',
      fields: [
        { id: 'list', label: 'Clé de la liste (vide : la première)', style: TextInputStyle.Short, placeholder: 'BOUT', required: false, maxLength: 10 },
        { id: 'title', label: 'Titre (vide : début du message)', style: TextInputStyle.Short, required: false, maxLength: 200 },
      ],
    },
    async run(ctx, input) {
      const [{ isModuleEnabled }, { default: prisma }, { createFreeCard }, { dashboardLink }] = await Promise.all([
        import('./moduleGate.js'),
        import('../../utils/db.js'),
        import('../staff/doingListBoard.js'),
        import('../notifications/notifyService.js'),
      ]);
      if (!(await isModuleEnabled(ctx.guild.id, 'doing_lists'))) {
        return fail('Listes de suivi éteintes', "Le module Listes de suivi n'est pas activé sur ce serveur.");
      }
      // Même public que le dashboard : le staff du serveur, ou qui le gère.
      const staff = await prisma.staffMember.findUnique({
        where: { guildId_userId: { guildId: ctx.guild.id, userId: ctx.invoker.id } },
        select: { id: true },
      });
      if (!staff && !ctx.invoker.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return fail('Réservé au staff', 'Seul le staff du serveur peut créer des cartes de suivi.');
      }

      const key = input.list?.trim().toUpperCase();
      const list = await prisma.doingList.findFirst({
        where: { guildId: ctx.guild.id, ...(key ? { key } : {}) },
        orderBy: { createdAt: 'asc' },
        select: { id: true, key: true, name: true },
      });
      if (!list) {
        const keys = (await prisma.doingList.findMany({ where: { guildId: ctx.guild.id }, select: { key: true }, take: 25 })).map((entry) => `\`${entry.key}\``);
        return fail(
          'Liste introuvable',
          keys.length ? `Aucune liste n'a la clé \`${key}\`. Listes du serveur : ${keys.join(', ')}.` : "Ce serveur n'a encore aucune liste de suivi : crée-la depuis le dashboard.",
        );
      }

      const content = ctx.message.content?.trim() ?? '';
      const title = input.title?.trim() || truncate(content.split('\n')[0] ?? '', 200) || `Message de ${ctx.message.author.username}`;
      const description = truncate(`${content}\n\nMessage d'origine : ${messageLink(ctx.message)} (${ctx.message.author.username})`.trim(), 4000);
      try {
        const item = await createFreeCard({
          guildId: ctx.guild.id,
          listId: list.id,
          title,
          description,
          actorId: ctx.invoker.id,
          actorName: ctx.invoker.user.username,
        });
        const link = dashboardLink(`/doing-lists/${list.id}?card=${item.id}`, ctx.guild.id);
        return ok('📋 Carte créée', `**${list.key}-${item.number}** · ${title}\nDans « ${list.name} ». [Ouvrir la carte](${link})`);
      } catch (error) {
        return fail('Création impossible', publicErrorMessage(error, 'Impossible de créer la carte.'));
      }
    },
  },
  {
    id: 'purge_here',
    scope: 'message',
    label: 'Purger jusqu\'ici',
    emoji: '🧹',
    description: 'Supprime ce message et tous ceux postés après',
    category: 'Modération',
    permission: PermissionFlagsBits.ManageMessages,
    async run(ctx) {
      const channel = ctx.message.channel;
      if (!channel.isTextBased() || channel.isDMBased()) {
        return fail('Salon incompatible', 'La purge n\'est possible que dans un salon textuel de serveur.');
      }

      // bulkDelete refuse les messages de plus de 14 jours.
      const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
      if (ctx.message.createdTimestamp < fourteenDaysAgo) {
        return fail(
          'Message trop ancien',
          'Discord interdit la suppression en masse des messages de plus de 14 jours. Utilise `/clear` pour un ciblage manuel.',
        );
      }

      try {
        const toDelete = await channel.messages.fetch({ after: ctx.message.id, limit: 100 });
        const batch = [...toDelete.values(), ctx.message].filter((m) => m.createdTimestamp >= fourteenDaysAgo);
        const deleted = await channel.bulkDelete(batch, true);

        return ok(
          'Purge effectuée',
          `**${deleted.size}** message(s) supprimé(s) dans <#${channel.id}>, à partir de celui de ${ctx.message.author}.${
            toDelete.size === 100 ? '\n\n-# Limite de 100 messages atteinte : relance pour continuer.' : ''
          }`,
        );
      } catch (error) {
        return fail('Purge impossible', publicErrorMessage(error, 'Impossible de purger ce salon.'));
      }
    },
  },
  {
    id: 'rep',
    scope: 'message',
    label: 'Donner de la réputation',
    emoji: '⭐',
    description: 'Récompense l\'auteur de ce message',
    category: 'Communauté',
    allowSelf: false,
    async run(ctx) {
      const { giveRep } = await import('../community/reputationService.js');
      const result = await giveRep(
        ctx.guild.id,
        ctx.invoker.id,
        ctx.message.author.id,
        `Message utile dans #${'name' in ctx.message.channel ? ctx.message.channel.name : 'salon'}`,
      );

      if (!result.success) {
        return fail('Réputation refusée', result.error ?? 'Impossible de donner de la réputation à ce membre.');
      }

      return ok(
        'Réputation donnée',
        `Tu as donné +1 réputation à ${ctx.message.author} pour [son message](${messageLink(ctx.message)}).\n\nIl/elle totalise désormais **${result.newTotal}** point(s).`,
      );
    },
  },
  {
    id: 'report',
    scope: 'message',
    label: 'Signaler ce message',
    emoji: '🚨',
    description: 'Signale ce message à l\'administrateur du bot',
    category: 'Modération',
    modal: {
      title: 'Signaler ce message',
      fields: [
        {
          id: 'reason',
          label: 'Raison du signalement',
          style: TextInputStyle.Paragraph,
          placeholder: 'Explique pourquoi ce message pose problème...',
          required: true,
          maxLength: 1000,
        },
      ],
    },
    async run(ctx, input) {
      const { sendReportToAdmin } = await import('../../commands/moderation/signal.js');
      const sent = await sendReportToAdmin({
        client: ctx.guild.client,
        reporter: ctx.invoker.user,
        target: ctx.message.author,
        reason: `${input.reason}\n\n- Message signalé : ${messageLink(ctx.message)}\n- Contenu : ${messagePreview(ctx.message)}`,
        guildName: ctx.guild.name,
        guildId: ctx.guild.id,
      });

      if (!sent) {
        return fail('Signalement échoué', "Impossible de transmettre le signalement à l'administrateur du bot.");
      }

      return ok('Signalement envoyé', `Le message de ${ctx.message.author} a été signalé à l'administrateur du bot.`);
    },
  },
  {
    id: 'vision_add',
    scope: 'message',
    label: 'Ajouter à Kotbo Vision',
    emoji: '🔍',
    description: 'Interdit les images de ce message sur le serveur, variantes comprises',
    category: 'Modération',
    permission: PermissionFlagsBits.ManageGuild,
    modal: {
      title: 'Ajouter à Kotbo Vision',
      fields: [
        {
          id: 'list',
          label: 'Liste (vide : catalogue du serveur)',
          style: TextInputStyle.Short,
          placeholder: 'Nom exact d\'une liste Kotbo Vision',
          required: false,
          maxLength: 100,
        },
        {
          id: 'delete',
          label: 'Supprimer le message ? (oui / non)',
          style: TextInputStyle.Short,
          placeholder: 'oui',
          required: false,
          maxLength: 3,
        },
      ],
    },
    async run(ctx, input) {
      const { addMessageImagesToCatalog } = await import('../moderation/visionService.js');
      const { default: prisma } = await import('../../utils/db.js');
      const listName = input.list?.trim();
      let listId: string | null = null;
      if (listName) {
        const list = await prisma.visionList.findFirst({ where: { guildId: ctx.guild.id, name: listName } });
        if (!list) return fail('Liste introuvable', `Aucune liste Kotbo Vision ne s'appelle « ${listName} ». Crée-la depuis le dashboard (Sécurité → Filtres → Kotbo Vision).`);
        listId = list.id;
      }
      const result = await addMessageImagesToCatalog(ctx.message, listId, ctx.invoker.id);
      if (result.added + result.variants + result.duplicates === 0) {
        return warn('Aucune image ajoutée', 'Ce message ne contient aucune image exploitable (illisible, unie ou introuvable).');
      }
      const shouldDelete = (input.delete?.trim().toLowerCase() || 'oui').startsWith('o');
      if (shouldDelete) await ctx.message.delete().catch(() => null);
      return ok(
        'Images ajoutées à Kotbo Vision',
        [
          `Registre : ${listName ? `liste « ${listName} »` : 'catalogue du serveur'}.`,
          `${result.added} ajoutée(s) · ${result.variants} variante(s) rattachée(s) · ${result.duplicates} déjà connue(s) · ${result.refused} refusée(s).`,
          shouldDelete ? 'Le message a été supprimé.' : 'Le message a été conservé.',
        ].join('\n'),
      );
    },
  },
  {
    id: 'delete_warn',
    scope: 'message',
    label: 'Supprimer + avertir',
    emoji: '⚠️',
    description: 'Supprime le message et prévient l\'auteur en MP',
    category: 'Modération',
    permission: PermissionFlagsBits.ModerateMembers,
    modal: {
      title: 'Supprimer et avertir',
      fields: [
        {
          id: 'reason',
          label: 'Motif communiqué à l\'auteur',
          style: TextInputStyle.Paragraph,
          placeholder: 'Ex: Message hors-sujet dans ce salon',
          required: true,
          maxLength: 500,
        },
      ],
    },
    async run(ctx, input) {
      const author = ctx.message.author;
      const channelName = 'name' in ctx.message.channel ? `#${ctx.message.channel.name}` : 'un salon';
      const preview = messagePreview(ctx.message);

      let deleted = false;
      try {
        await ctx.message.delete();
        deleted = true;
      } catch (error) {
        return fail('Suppression impossible', publicErrorMessage(error, 'Impossible de supprimer ce message.'));
      }

      let dmSent = true;
      try {
        const container = kotboContainer({
          color: 'warning',
          title: '⚠️ Message supprimé',
          fields: [
            `Ton message dans **${channelName}** sur **${ctx.guild.name}** a été supprimé par la modération.`,
            separator({ divider: true, spacing: 'small' }),
            `**Motif**\n${input.reason}`,
            `**Contenu supprimé**\n>>> ${preview}`,
          ],
        });

        await author.send(v2Message(container));
      } catch {
        dmSent = false;
      }

      return ok(
        'Message supprimé',
        [
          `Le message de ${author} dans **${channelName}** a été supprimé.`,
          `**Motif** : ${input.reason}`,
          dmSent ? '✅ L\'auteur a été prévenu en MP.' : '⚠️ L\'auteur n\'a **pas** pu être prévenu (MP fermés).',
          deleted ? '' : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      );
    },
  },
];

// ─────────────────────────────────────────────────────────────
// Actions - clic droit sur un UTILISATEUR
// ─────────────────────────────────────────────────────────────

const userActions: UserAction[] = [
  {
    id: 'rank',
    scope: 'user',
    label: 'Niveau et rang',
    emoji: '📊',
    description: 'Affiche le niveau, l\'XP et le classement',
    category: 'Profil',
    async run(ctx) {
      const { getMemberRankData } = await import('../progression/levelingService.js');
      const data = await getMemberRankData(ctx.guild.id, ctx.targetId);

      const progress = data.xpRequiredForNextLevel > 0 ? data.xpInCurrentLevel / data.xpRequiredForNextLevel : 0;
      const filled = Math.round(progress * 12);
      const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, 12 - filled));

      return info(
        '📊 Progression',
        [
          `<@${ctx.targetId}>`,
          '',
          `**Niveau** ${data.level} · **Rang** #${data.rank}`,
          `**XP total** ${data.totalXp.toLocaleString('fr-FR')}`,
          '',
          `\`${bar}\` ${data.xpInCurrentLevel.toLocaleString('fr-FR')} / ${data.xpRequiredForNextLevel.toLocaleString('fr-FR')} XP`,
        ].join('\n'),
      );
    },
  },
  {
    id: 'account',
    scope: 'user',
    label: 'Infos du compte',
    emoji: '🪪',
    description: 'Ancienneté du compte, arrivée, rôles',
    category: 'Profil',
    async run(ctx) {
      const member = await ctx.guild.members.fetch(ctx.targetId).catch(() => null);
      const user = member?.user ?? (await ctx.guild.client.users.fetch(ctx.targetId).catch(() => null));
      if (!user) return fail('Introuvable', 'Impossible de récupérer ce compte Discord.');

      const lines = [
        `<@${user.id}> · \`${user.id}\``,
        '',
        `**Compte créé** <t:${Math.floor(user.createdTimestamp / 1000)}:R> (<t:${Math.floor(user.createdTimestamp / 1000)}:D>)`,
      ];

      if (member?.joinedTimestamp) {
        lines.push(`**A rejoint** <t:${Math.floor(member.joinedTimestamp / 1000)}:R> (<t:${Math.floor(member.joinedTimestamp / 1000)}:D>)`);
      } else {
        lines.push("**A rejoint** *n'est plus sur le serveur*");
      }

      if (member) {
        const roles = member.roles.cache.filter((r) => r.id !== ctx.guild.id).sort((a, b) => b.position - a.position);
        lines.push(
          '',
          `**Rôles (${roles.size})**`,
          roles.size > 0 ? truncate(roles.map((r) => `<@&${r.id}>`).join(' '), 800) : '*Aucun*',
        );
        if (member.communicationDisabledUntilTimestamp && member.communicationDisabledUntilTimestamp > Date.now()) {
          lines.push('', `⏳ **Timeout actif** jusqu'à <t:${Math.floor(member.communicationDisabledUntilTimestamp / 1000)}:F>`);
        }
      }

      return info(`🪪 ${user.username}`, lines.join('\n'));
    },
  },
  {
    id: 'rep',
    scope: 'user',
    label: 'Donner de la réputation',
    emoji: '⭐',
    description: 'Donne +1 réputation à ce membre',
    category: 'Communauté',
    allowSelf: false,
    async run(ctx) {
      const { giveRep } = await import('../community/reputationService.js');
      const result = await giveRep(ctx.guild.id, ctx.invoker.id, ctx.targetId);

      if (!result.success) {
        return fail('Réputation refusée', result.error ?? 'Impossible de donner de la réputation à ce membre.');
      }

      return ok('Réputation donnée', `Tu as donné +1 réputation à <@${ctx.targetId}>.\n\nIl/elle totalise désormais **${result.newTotal}** point(s).`);
    },
  },
  {
    id: 'timeout',
    scope: 'user',
    label: 'Timeout rapide',
    emoji: '🔇',
    description: 'Réduit ce membre au silence temporairement',
    category: 'Modération',
    permission: PermissionFlagsBits.ModerateMembers,
    allowSelf: false,
    modal: {
      title: 'Timeout rapide',
      fields: [
        {
          id: 'duration',
          label: 'Durée (ex: 10m, 2h, 1d - max 28d)',
          style: TextInputStyle.Short,
          placeholder: '10m',
          required: true,
          maxLength: 10,
        },
        {
          id: 'reason',
          label: 'Motif',
          style: TextInputStyle.Paragraph,
          placeholder: 'Motif du timeout...',
          required: true,
          maxLength: 500,
        },
      ],
    },
    async run(ctx, input) {
      const durationMs = parseDuration(input.duration ?? '');
      if (durationMs === null) {
        return fail('Durée invalide', 'Utilise un format comme `10m`, `2h` ou `1d`. Maximum autorisé par Discord : 28 jours.');
      }

      const member = await ctx.guild.members.fetch(ctx.targetId).catch(() => null);
      if (!member) return fail('Membre introuvable', "Ce membre n'est plus sur le serveur.");

      if (!member.moderatable) {
        return fail(
          'Timeout impossible',
          'Je ne peux pas timeout ce membre : son rôle le plus haut est au-dessus du mien, ou il est administrateur.',
        );
      }

      if (ctx.invoker.roles.highest.position <= member.roles.highest.position && ctx.guild.ownerId !== ctx.invoker.id) {
        return fail('Hiérarchie insuffisante', 'Tu ne peux pas timeout un membre dont le rôle est supérieur ou égal au tien.');
      }

      try {
        await member.timeout(durationMs, `${input.reason} - par ${ctx.invoker.user.tag}`);
      } catch (error) {
        return fail('Timeout impossible', publicErrorMessage(error, 'Discord a refusé le timeout.'));
      }

      const until = Math.floor((Date.now() + durationMs) / 1000);
      return ok(
        'Timeout appliqué',
        `<@${ctx.targetId}> est réduit au silence jusqu'à <t:${until}:F> (<t:${until}:R>).\n\n**Motif** : ${input.reason}`,
      );
    },
  },
  {
    id: 'alt',
    scope: 'user',
    label: 'Détection de double compte',
    emoji: '🕵️',
    description: 'Analyse les soupçons de multi-compte',
    category: 'Modération',
    permission: PermissionFlagsBits.ModerateMembers,
    async run(ctx) {
      const { getDetectionEvidence } = await import('../moderation/dcDetectionService.js');
      const evidence = await getDetectionEvidence(ctx.guild.id, ctx.targetId);

      if (!evidence || evidence.reasons.length === 0) {
        return ok('Aucun soupçon', `Aucun indice de double compte n'est enregistré pour <@${ctx.targetId}>.`);
      }

      const topReasons = [...evidence.reasons]
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .map((r) => `• **${r.label}** - ${r.score}/100${r.matchedUserId ? ` (↔ <@${r.matchedUserId}>)` : ''}${r.detail ? `\n  -# ${truncate(r.detail, 120)}` : ''}`)
        .join('\n');

      const severity = evidence.totalScore >= 70 ? fail : evidence.totalScore >= 40 ? warn : info;

      return severity(
        '🕵️ Détection de double compte',
        [
          `<@${ctx.targetId}> · score global **${evidence.totalScore}/100**`,
          `Analysé <t:${Math.floor(new Date(evidence.detectedAt).getTime() / 1000)}:R>`,
          '',
          evidence.suspectedAlts.length > 0
            ? `**Comptes suspectés**\n${evidence.suspectedAlts.map((id) => `<@${id}>`).join(' · ')}\n`
            : '',
          `**Indices (${evidence.reasons.length})**`,
          topReasons,
          evidence.reasons.length > 10 ? `\n-# ${evidence.reasons.length - 10} indice(s) supplémentaire(s) non affiché(s).` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    },
  },
  {
    id: 'linked',
    scope: 'user',
    label: 'Comptes liés',
    emoji: '🔗',
    description: 'Liste les comptes liés à ce membre',
    category: 'Modération',
    permission: PermissionFlagsBits.ModerateMembers,
    async run(ctx) {
      const { getAllLinkedUserIds } = await import('../moderation/altAccountService.js');
      const linked = (await getAllLinkedUserIds(ctx.guild.id, ctx.targetId)).filter((id) => id !== ctx.targetId);

      if (linked.length === 0) {
        return info('Aucun compte lié', `<@${ctx.targetId}> n'est lié à aucun autre compte sur ce serveur.`);
      }

      return info(
        '🔗 Comptes liés',
        `<@${ctx.targetId}> est lié à **${linked.length}** compte(s) :\n\n${linked.map((id) => `• <@${id}> · \`${id}\``).join('\n')}`,
      );
    },
  },
  {
    id: 'rename',
    scope: 'user',
    label: 'Renommer',
    emoji: '✏️',
    description: 'Change le pseudo de ce membre',
    category: 'Modération',
    permission: PermissionFlagsBits.ManageNicknames,
    modal: {
      title: 'Renommer le membre',
      fields: [
        {
          id: 'nickname',
          label: 'Nouveau pseudo (vide = réinitialiser)',
          style: TextInputStyle.Short,
          placeholder: 'Laisse vide pour retirer le pseudo',
          required: false,
          maxLength: 32,
        },
      ],
    },
    async run(ctx, input) {
      const member = await ctx.guild.members.fetch(ctx.targetId).catch(() => null);
      if (!member) return fail('Membre introuvable', "Ce membre n'est plus sur le serveur.");

      if (!member.manageable) {
        return fail('Renommage impossible', 'Je ne peux pas modifier ce membre : son rôle le plus haut est au-dessus du mien.');
      }

      const previous = member.nickname ?? member.user.username;
      const next = input.nickname?.trim() || null;

      try {
        await member.setNickname(next, `Renommé via menu contextuel par ${ctx.invoker.user.tag}`);
      } catch (error) {
        return fail('Renommage impossible', publicErrorMessage(error, 'Discord a refusé le changement de pseudo.'));
      }

      return ok(
        'Pseudo mis à jour',
        `<@${ctx.targetId}>\n\n**Avant** : ${previous}\n**Après** : ${next ?? `*réinitialisé* (${member.user.username})`}`,
      );
    },
  },
  {
    id: 'dm',
    scope: 'user',
    label: 'Envoyer un MP via le bot',
    emoji: '📨',
    description: 'Envoie un message privé au nom du bot',
    category: 'Modération',
    permission: PermissionFlagsBits.ManageGuild,
    allowSelf: false,
    modal: {
      title: 'Envoyer un MP',
      fields: [
        {
          id: 'content',
          label: 'Message',
          style: TextInputStyle.Paragraph,
          placeholder: 'Le message envoyé au membre au nom du bot...',
          required: true,
          maxLength: 1800,
        },
      ],
    },
    async run(ctx, input) {
      const member = await ctx.guild.members.fetch(ctx.targetId).catch(() => null);
      if (!member) return fail('Membre introuvable', "Ce membre n'est plus sur le serveur.");

      try {
        const container = kotboContainer({
          color: 'primary',
          title: `📨 Message de l'équipe de ${ctx.guild.name}`,
          fields: [input.content ?? ''],
        });

        await member.send(v2Message(container));
      } catch {
        return fail('MP bloqué', `<@${ctx.targetId}> n'accepte pas les messages privés venant de ce serveur.`);
      }

      return ok('MP envoyé', `Message transmis à <@${ctx.targetId}> au nom du bot.\n\n**Contenu**\n>>> ${truncate(input.content ?? '', 500)}`);
    },
  },
  {
    id: 'invites',
    scope: 'user',
    label: 'Historique d\'invitation',
    emoji: '🧾',
    description: 'Qui l\'a invité et combien il a invité',
    category: 'Modération',
    permission: PermissionFlagsBits.ManageGuild,
    async run(ctx) {
      const invites = await ctx.guild.invites.fetch().catch(() => null);
      if (!invites) {
        return fail('Invitations inaccessibles', "Je n'ai pas la permission de lire les invitations de ce serveur.");
      }

      const owned = invites.filter((i) => i.inviter?.id === ctx.targetId);
      const totalUses = owned.reduce((sum, i) => sum + (i.uses ?? 0), 0);

      if (owned.size === 0) {
        return info('Aucune invitation', `<@${ctx.targetId}> n'a aucune invitation active sur ce serveur.`);
      }

      const list = [...owned.values()]
        .sort((a, b) => (b.uses ?? 0) - (a.uses ?? 0))
        .slice(0, 10)
        .map((i) => `• \`${i.code}\` - **${i.uses ?? 0}** utilisation(s)${i.channel ? ` · <#${i.channel.id}>` : ''}`)
        .join('\n');

      return info(
        '🧾 Invitations',
        `<@${ctx.targetId}> possède **${owned.size}** invitation(s) active(s), pour **${totalUses}** arrivée(s) au total.\n\n${list}`,
      );
    },
  },
];

// ─────────────────────────────────────────────────────────────
// Utilitaires
// ─────────────────────────────────────────────────────────────

const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

/** Parse `10m`, `2h`, `1d`… en millisecondes. `null` si invalide ou hors bornes Discord. */
export function parseDuration(raw: string): number | null {
  const match = raw.trim().toLowerCase().match(/^(\d+)\s*(s|m|h|d|j)$/);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;

  const unitMs: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    j: 24 * 60 * 60 * 1000,
  };

  const ms = value * (unitMs[match[2]!] ?? 0);
  if (ms <= 0 || ms > MAX_TIMEOUT_MS) return null;
  return ms;
}

export const contextActions: ContextAction[] = [...messageActions, ...userActions];

export function getAction(scope: ContextActionScope, id: string): ContextAction | undefined {
  return contextActions.find((a) => a.scope === scope && a.id === id);
}

/**
 * Actions visibles pour ce membre : filtre sur les permissions, et retire les
 * actions qui n'ont pas de sens sur soi-même.
 */
export function visibleActions(scope: ContextActionScope, invoker: GuildMember, targetId: string): ContextAction[] {
  const isSelf = invoker.id === targetId;
  return contextActions.filter((action) => {
    if (action.scope !== scope) return false;
    if (action.permission && !invoker.permissions.has(action.permission)) return false;
    if (isSelf && action.allowSelf === false) return false;
    return true;
  });
}

export function buildActionModal(action: ContextAction, targetRef: string): ModalBuilder | null {
  if (!action.modal) return null;

  const modal = new ModalBuilder()
    .setCustomId(`ctxhub_modal:${action.scope}:${action.id}:${targetRef}`)
    .setTitle(truncate(action.modal.title, 45));

  for (const field of action.modal.fields) {
    const input = new TextInputBuilder()
      .setCustomId(field.id)
      .setLabel(truncate(field.label, 45))
      .setStyle(field.style)
      .setRequired(field.required ?? true);

    if (field.placeholder) input.setPlaceholder(field.placeholder);
    if (field.maxLength) input.setMaxLength(field.maxLength);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  }

  return modal;
}

export function readModalInput(action: ContextAction, interaction: ModalSubmitInteraction): Record<string, string> {
  const input: Record<string, string> = {};
  for (const field of action.modal?.fields ?? []) {
    input[field.id] = interaction.fields.getTextInputValue(field.id);
  }
  return input;
}

export { messageActions, userActions };
