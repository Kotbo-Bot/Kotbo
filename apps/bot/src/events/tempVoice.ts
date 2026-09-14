/**
 * Salons vocaux temporaires : creation, panneau de gestion, nettoyage.
 *
 * Les regles appliquees a la creation (places, verrouillage, roles autorises
 * d'office, chat texte, pouvoirs du proprietaire) ne vivent plus ici : elles
 * viennent de `tempVoiceService`, qui les normalise et calcule les surcharges.
 * Cet ecouteur ne fait que les traduire en appels Discord et tenir l'etat des
 * salons ouverts.
 *
 * Deux invariants portent tout le module :
 *
 * 1. Un salon temporaire ne doit jamais etre plus ouvert que sa categorie. Les
 *    surcharges heritees sont completees bit a bit, jamais remplacees, et les
 *    boutons qui « rouvrent » un salon remettent le droit a l'heritage (`null`)
 *    au lieu de l'autoriser explicitement - sans quoi un salon temporaire
 *    deviendrait, sur un serveur ferme, le seul ou entrer sans verification.
 *
 * 2. Ce que le bot annonce doit s'etre produit. Les appels Discord echouent
 *    (droits manquants, limite de renommage, salon supprime entre-temps) : leur
 *    resultat est verifie avant de repondre, plutot que d'annoncer un succes
 *    dans tous les cas.
 */
import {
  Client,
  Events,
  VoiceState,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Interaction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  MessageFlags,
  RoleSelectMenuBuilder,
  UserSelectMenuBuilder,
  GuildMember,
  type Guild as DiscordGuild,
  type VoiceChannel,
} from 'discord.js';
import prisma from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { getCachedGuild } from '../utils/cache.js';
import {
  buildCreationOverwrites,
  CHANNEL_PATCHES,
  ownerPermissionPatch,
  ownerPowersFromBits,
  ownerRevokedPermissions,
  renderChannelName,
  resolveTempVoiceGenerators,
  toOverwriteDrafts,
  type TempVoiceGenerator,
  type TempVoiceGuildConfig,
} from '../services/features/tempVoiceService.js';

/** Salons temporaires ouverts : identifiant du salon -> proprietaire courant. */
export const tempChannels = new Map<string, { creatorId: string }>();

/**
 * Membres pour qui une creation est en cours.
 *
 * Rejoindre puis quitter le generateur plus vite que la reponse de Discord
 * declenchait autant de creations que d'aller-retours : le membre se retrouvait
 * avec une grappe de salons vides, et le serveur avec autant d'appels API.
 */
const creationInFlight = new Set<string>();

/** Droits sans lesquels le module ne peut pas faire son travail. */
const REQUIRED_BOT_PERMISSIONS = [
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.MoveMembers,
] as const;

function missingBotPermissions(guild: DiscordGuild): string[] {
  const me = guild.members.me;
  if (!me) return [];

  const labels: Record<string, string> = {
    [String(PermissionFlagsBits.ManageChannels)]: 'Gérer les salons',
    [String(PermissionFlagsBits.MoveMembers)]: 'Déplacer les membres',
  };

  return REQUIRED_BOT_PERMISSIONS
    .filter((permission) => !me.permissions.has(permission))
    .map((permission) => labels[String(permission)] ?? String(permission));
}

/**
 * Le staff peut piloter n'importe quel salon temporaire.
 *
 * Sans cette porte, un salon renomme en insulte ou verrouille par son
 * proprietaire ne pouvait etre repris que depuis le dashboard : la moderation
 * de terrain, elle, se fait dans Discord.
 */
async function isStaff(guildId: string, member: GuildMember | null): Promise<boolean> {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (member.id === member.guild.ownerId) return true;

  const guildConfig = await getCachedGuild(guildId);
  if (!guildConfig) return false;

  return Boolean(
    (guildConfig.baseStaffRoleId && member.roles.cache.has(guildConfig.baseStaffRoleId)) ||
    (guildConfig.moderatorRoleId && member.roles.cache.has(guildConfig.moderatorRoleId)) ||
    (guildConfig.testStaffRoleId && member.roles.cache.has(guildConfig.testStaffRoleId)),
  );
}

/** Un membre du staff ne peut etre ni expulse ni banni de son propre serveur. */
async function isProtectedTarget(guildId: string, target: GuildMember): Promise<boolean> {
  if (target.id === process.env.DISCORD_CLIENT_OWNER_ID) return true;
  return isStaff(guildId, target);
}

/** Ferme un salon temporaire et oublie tout ce qui s'y rapporte. */
async function closeTempChannel(channel: VoiceChannel, reason: string): Promise<void> {
  tempChannels.delete(channel.id);
  await prisma.tempVoiceChannel.delete({ where: { id: channel.id } }).catch(() => null);
  await channel.delete(reason).catch(() => null);
}

/**
 * Salons temporaires laisses par la session precedente.
 *
 * Un salon ne disparaissait qu'au depart de son dernier occupant : ceux deja
 * vides au demarrage - bot arrete pendant la nuit, creation interrompue -
 * restaient ouverts indefiniment, et le serveur accumulait des salons morts que
 * seul un menage manuel enlevait.
 */
async function sweepOrphanChannels(client: Client): Promise<void> {
  const guildIds = [...client.guilds.cache.keys()];
  if (guildIds.length === 0) return;

  const stored = await prisma.tempVoiceChannel
    .findMany({ where: { guildId: { in: guildIds } } })
    .catch((err: unknown) => {
      logger.error('TempVoice', 'Lecture des salons temporaires impossible :', err);
      return [] as Array<{ id: string; creatorId: string; guildId: string }>;
    });

  let restored = 0;
  let removed = 0;

  for (const entry of stored) {
    const guild = client.guilds.cache.get(entry.guildId);
    const channel = guild?.channels.cache.get(entry.id);

    if (!channel || channel.type !== ChannelType.GuildVoice) {
      // Le salon a ete supprime sur Discord : la ligne ne designe plus rien.
      tempChannels.delete(entry.id);
      await prisma.tempVoiceChannel.delete({ where: { id: entry.id } }).catch(() => null);
      removed += 1;
      continue;
    }

    if (channel.members.size === 0) {
      await closeTempChannel(channel, 'Salon vocal temporaire vide au démarrage');
      removed += 1;
      continue;
    }

    tempChannels.set(entry.id, { creatorId: entry.creatorId });
    restored += 1;
  }

  logger.success(
    'TempVoice',
    `${restored} salon(s) temporaire(s) repris, ${removed} nettoyé(s) au démarrage.`,
  );
}

/** Panneau de gestion poste dans le salon fraichement cree. */
function buildControlPanel(ownerId: string) {
  const embed = new EmbedBuilder()
    .setTitle('⚙️ Gestion de votre salon vocal')
    .setDescription(
      `Bonjour <@${ownerId}> !\nVous venez de créer votre salon temporaire. Utilisez les boutons ci-dessous pour le configurer.\n\n` +
      '🔒 **Verrouiller** : Interdit l\'accès au salon\n' +
      '🔓 **Déverrouiller** : Rend l\'accès au salon à sa configuration d\'origine\n' +
      '👥 **Limite** : Modifie le nombre maximum de places\n' +
      '✏️ **Renommer** : Modifie le nom du salon\n' +
      '💬 **Chat** : Ouvre ou ferme le chat écrit du salon\n' +
      '👢 **Expulser** : Expulse un membre du salon\n' +
      '🚫 **Bannir** : Interdit le salon à un membre, chat écrit compris\n' +
      '➕ **Ajouter** : Autorise un membre à rejoindre\n' +
      '👑 **Transférer** : Transfère la propriété du salon\n' +
      '🙋 **Récupérer** : Récupère la propriété (si le propriétaire a quitté)\n' +
      '🛡️ **Réserver** : Réserve le salon pour un rôle spécifique',
    )
    .setColor('#5865F2')
    .setTimestamp();

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('tempvoice:lock').setLabel('Verrouiller').setStyle(ButtonStyle.Secondary).setEmoji('🔒'),
    new ButtonBuilder().setCustomId('tempvoice:unlock').setLabel('Déverrouiller').setStyle(ButtonStyle.Success).setEmoji('🔓'),
    new ButtonBuilder().setCustomId('tempvoice:limit').setLabel('Limite').setStyle(ButtonStyle.Primary).setEmoji('👥'),
    new ButtonBuilder().setCustomId('tempvoice:rename').setLabel('Renommer').setStyle(ButtonStyle.Primary).setEmoji('✏️'),
    new ButtonBuilder().setCustomId('tempvoice:chat').setLabel('Chat').setStyle(ButtonStyle.Secondary).setEmoji('💬'),
  );

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('tempvoice:kick').setLabel('Expulser').setStyle(ButtonStyle.Danger).setEmoji('👢'),
    new ButtonBuilder().setCustomId('tempvoice:ban').setLabel('Bannir').setStyle(ButtonStyle.Danger).setEmoji('🚫'),
    new ButtonBuilder().setCustomId('tempvoice:trust').setLabel('Ajouter').setStyle(ButtonStyle.Success).setEmoji('➕'),
    new ButtonBuilder().setCustomId('tempvoice:transfer').setLabel('Transférer').setStyle(ButtonStyle.Primary).setEmoji('👑'),
    new ButtonBuilder().setCustomId('tempvoice:claim').setLabel('Récupérer').setStyle(ButtonStyle.Secondary).setEmoji('🙋'),
  );

  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('tempvoice:reserve').setLabel('Réserver').setStyle(ButtonStyle.Secondary).setEmoji('🛡️'),
  );

  return { embeds: [embed], components: [row1, row2, row3] };
}

/** Cree le salon d'un membre qui vient de rejoindre un generateur. */
async function createTempChannel(
  state: VoiceState,
  member: GuildMember,
  generator: TempVoiceGenerator,
): Promise<void> {
  const guild = member.guild;

  const missing = missingBotPermissions(guild);
  if (missing.length > 0) {
    // Sans ces droits, `channels.create` echoue et le membre reste dans le
    // generateur sans la moindre explication.
    logger.warn('TempVoice', `Droits manquants sur ${guild.name} (${guild.id}) : ${missing.join(', ')}`);
    await member
      .send(`❌ Le salon temporaire n'a pas pu être créé sur **${guild.name}** : il manque au bot le droit « ${missing.join(' » et « ')} ».`)
      .catch(() => null);
    return;
  }

  // Le generateur peut ne pas etre range dans une categorie, et l'identifiant
  // configure peut pointer sur un salon supprime ou recree autrement : sans
  // categorie parente, il n'y a rien a heriter.
  const parentCategory = generator.categoryId ? guild.channels.cache.get(generator.categoryId) : undefined;
  const inherited = parentCategory?.type === ChannelType.GuildCategory
    ? toOverwriteDrafts(parentCategory.permissionOverwrites.cache.values())
    : [];

  const tempChannel = await guild.channels
    .create({
      name: renderChannelName(generator.nameTemplate, member.displayName || member.user.username),
      type: ChannelType.GuildVoice,
      parent: generator.categoryId,
      userLimit: generator.policy.userLimit,
      permissionOverwrites: buildCreationOverwrites({
        everyoneRoleId: guild.id,
        ownerId: member.id,
        inherited,
        policy: generator.policy,
      }),
      reason: `Création de salon temporaire pour ${member.user.tag}`,
    })
    .catch((err: unknown) => {
      logger.error('TempVoice', `Création du salon temporaire impossible sur ${guild.id} :`, err);
      return null;
    });

  if (!tempChannel) return;

  // Le deplacement echoue si le membre a deja quitte le vocal. Garder le salon
  // dans ce cas laissait un salon vide que rien ne supprimait ensuite : la
  // suppression n'est declenchee que par le depart d'un occupant.
  const moved = await state.setChannel(tempChannel).then(() => true).catch(() => false);
  if (!moved) {
    await tempChannel.delete('Déplacement vers le salon temporaire impossible').catch(() => null);
    logger.warn('TempVoice', `Déplacement impossible pour ${member.user.tag}, salon temporaire annulé.`);
    return;
  }

  tempChannels.set(tempChannel.id, { creatorId: member.id });

  await prisma.tempVoiceChannel
    .create({ data: { id: tempChannel.id, guildId: guild.id, creatorId: member.id } })
    .catch((err: unknown) => logger.error('TempVoice', 'Erreur création salon temporaire BDD :', err));

  await tempChannel
    .send({ content: `<@${member.id}>`, ...buildControlPanel(member.id) })
    .catch(() => null);

  logger.info('TempVoice', `Salon créé : ${tempChannel.name} (${tempChannel.id})`);
}

export function registerTempVoiceListener(client: Client): void {
  // Le balayage a besoin du cache des salons, donc d'un client pret. Les
  // serveurs arrivent avec l'evenement `ClientReady`, pas avant.
  const scheduleSweep = () => {
    void sweepOrphanChannels(client).catch((err: unknown) => {
      logger.error('TempVoice', 'Balayage des salons temporaires en échec :', err);
    });
  };

  if (client.isReady()) scheduleSweep();
  else client.once(Events.ClientReady, scheduleSweep);

  client.on(Events.VoiceStateUpdate, async (oldState: VoiceState, newState: VoiceState) => {
    const { member, guild } = newState;
    if (!member || member.user.bot) return;

    try {
      const guildConfig = await getCachedGuild(guild.id);
      if (!guildConfig || !guildConfig.tempVoiceEnabled) return;

      // 1. Creation : le membre vient de rejoindre un generateur.
      if (newState.channelId) {
        const generators = resolveTempVoiceGenerators(guildConfig as unknown as TempVoiceGuildConfig);
        const generator = generators.find((entry) => entry.channelId === newState.channelId);

        if (generator) {
          if (generator.requiredRoleId && !member.roles.cache.has(generator.requiredRoleId)) {
            await newState.disconnect('Accès au salon générateur restreint').catch(() => null);
            await member
              .send(`❌ Vous n'avez pas le rôle requis pour utiliser le salon générateur de salons temporaires sur le serveur **${guild.name}**.`)
              .catch(() => null);
            return;
          }

          const inFlightKey = `${guild.id}:${member.id}`;
          if (creationInFlight.has(inFlightKey)) return;
          creationInFlight.add(inFlightKey);
          try {
            await createTempChannel(newState, member, generator);
          } finally {
            creationInFlight.delete(inFlightKey);
          }
        }
      }

      // 2. Suppression : le dernier occupant vient de partir.
      if (oldState.channelId && oldState.channelId !== newState.channelId) {
        const oldChannel = oldState.channel;
        if (
          oldChannel &&
          oldChannel.type === ChannelType.GuildVoice &&
          tempChannels.has(oldChannel.id) &&
          oldChannel.members.size === 0
        ) {
          await closeTempChannel(oldChannel, 'Salon vocal temporaire vide');
          logger.info('TempVoice', `Salon supprimé car vide : ${oldChannel.name} (${oldChannel.id})`);
        }
      }
    } catch (err) {
      logger.error('TempVoice', 'Erreur lors de la gestion voiceStateUpdate :', err);
    }
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.guildId) return;
    if (!interaction.isButton() && !interaction.isModalSubmit() && !interaction.isRoleSelectMenu() && !interaction.isUserSelectMenu()) return;
    if (!interaction.customId.startsWith('tempvoice:')) return;

    const { channel, user, guild, guildId } = interaction;
    if (!guild || !channel || channel.type !== ChannelType.GuildVoice) return;

    const cache = tempChannels.get(channel.id);
    if (!cache) {
      await interaction
        .reply({ content: "❌ Ce salon n'est plus enregistré comme temporaire.", flags: [MessageFlags.Ephemeral] })
        .catch(() => null);
      return;
    }

    const action = interaction.customId.split(':')[1] ?? '';
    const actingMember = interaction.member instanceof GuildMember
      ? interaction.member
      : await guild.members.fetch(user.id).catch(() => null);

    // `claim` est la seule action ouverte a autrui : c'est elle qui rend un
    // salon dont le proprietaire est parti.
    if (action !== 'claim' && cache.creatorId !== user.id && !(await isStaff(guildId, actingMember))) {
      await interaction
        .reply({ content: '❌ Seul le propriétaire du salon peut effectuer cette action.', flags: [MessageFlags.Ephemeral] })
        .catch(() => null);
      return;
    }

    try {
      await handleTempVoiceAction({ interaction, action, channel, cache, guild, guildId, actingMember });
    } catch (err) {
      logger.error('TempVoice', `Action « ${action} » en échec :`, err);
      const message = { content: "❌ L'action n'a pas pu être appliquée.", flags: [MessageFlags.Ephemeral] as const };
      await (interaction.isRepliable() && (interaction.replied || interaction.deferred)
        ? interaction.followUp(message).catch(() => null)
        : interaction.reply(message).catch(() => null));
    }
  });

  logger.success('TempVoice', 'Écouteur Vocal Temporaire enregistré');
}

interface ActionContext {
  interaction: Interaction & { customId: string };
  action: string;
  channel: VoiceChannel;
  cache: { creatorId: string };
  guild: DiscordGuild;
  guildId: string;
  actingMember: GuildMember | null;
}

/** Ouvre une fenetre de saisie a une seule ligne. */
function textModal(customId: string, title: string, label: string, placeholder: string, maxLength: number) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('value')
          .setLabel(label)
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(placeholder)
          .setMaxLength(maxLength)
          .setRequired(true),
      ),
    );
}

/** Choisit un membre dans une liste plutot que de le chercher par son pseudo. */
function userPicker(customId: string, placeholder: string) {
  return new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
    new UserSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).setMinValues(1).setMaxValues(1),
  );
}

async function handleTempVoiceAction(ctx: ActionContext): Promise<void> {
  const { interaction, action, channel, cache, guild, guildId } = ctx;
  const user = interaction.user;

  const ephemeral = { flags: [MessageFlags.Ephemeral] as const };
  const reply = (content: string) => interaction.isRepliable()
    ? interaction.reply({ content, ...ephemeral }).catch(() => null)
    : Promise.resolve(null);

  // ---------------------------------------------------------------------------
  // Boutons qui agissent directement
  // ---------------------------------------------------------------------------
  if (interaction.isButton()) {
    switch (action) {
      case 'lock': {
        await channel.permissionOverwrites.edit(guildId, CHANNEL_PATCHES.lock);
        await reply('🔒 Le salon a été verrouillé. Plus personne ne peut le rejoindre.');
        return;
      }

      case 'unlock': {
        await channel.permissionOverwrites.edit(guildId, CHANNEL_PATCHES.unlock);
        await reply("🔓 Le salon a été déverrouillé : il retrouve l'accès prévu par sa catégorie.");
        return;
      }

      case 'chat': {
        // L'etat courant decide du sens de la bascule : le proprietaire n'a pas
        // a savoir ce que la categorie prevoit pour fermer son chat.
        const everyone = channel.permissionOverwrites.cache.get(guildId);
        const chatOuvert = !everyone?.deny.has(PermissionFlagsBits.SendMessages);

        if (chatOuvert) {
          await channel.permissionOverwrites.edit(guildId, CHANNEL_PATCHES.closeChat);
          // Le proprietaire garde la parole dans son salon : sans cette ligne,
          // fermer le chat le fermerait aussi pour lui.
          await channel.permissionOverwrites.edit(cache.creatorId, { SendMessages: true });
          await reply('💬 Le chat écrit du salon est fermé : vous seul pouvez y écrire.');
        } else {
          await channel.permissionOverwrites.edit(guildId, CHANNEL_PATCHES.openChat);
          await channel.permissionOverwrites.edit(cache.creatorId, CHANNEL_PATCHES.openChat);
          await reply("💬 Le chat écrit du salon retrouve l'accès prévu par sa catégorie.");
        }
        return;
      }

      case 'claim': {
        if (channel.members.has(cache.creatorId)) {
          await reply('❌ Le propriétaire actuel du salon vocal est toujours présent.');
          return;
        }
        // On ne reprend que le salon ou l'on se trouve : le panneau reste
        // lisible depuis l'exterieur, et rien n'empechait jusqu'ici de prendre
        // la main sur un salon que l'on n'avait pas rejoint.
        if (!channel.members.has(user.id)) {
          await reply("❌ Rejoignez le salon vocal avant d'en récupérer la propriété.");
          return;
        }
        await transferOwnership(ctx, ctx.actingMember ?? null, 'claim');
        return;
      }

      case 'limit': {
        await interaction.showModal(
          textModal('tempvoice:limit_modal', "👥 Limite d'utilisateurs", 'Nombre max (0 pour illimité, max 99)', 'Ex: 5', 2),
        );
        return;
      }

      case 'rename': {
        await interaction.showModal(
          textModal('tempvoice:rename_modal', '✏️ Renommer le salon', 'Nouveau nom du salon', 'Ex: Blabla Gaming', 50),
        );
        return;
      }

      case 'kick':
      case 'ban':
      case 'trust':
      case 'transfer': {
        // Un selecteur de membre remplace la recherche par pseudo : celle-ci
        // prenait le premier resultat, donc parfois le mauvais membre.
        const labels: Record<string, string> = {
          kick: '👢 Sélectionnez le membre à expulser du salon.',
          ban: '🚫 Sélectionnez le membre à bannir du salon.',
          trust: '➕ Sélectionnez le membre à autoriser.',
          transfer: '👑 Sélectionnez le nouveau propriétaire du salon.',
        };
        await interaction.reply({
          content: labels[action] ?? 'Sélectionnez un membre.',
          components: [userPicker(`tempvoice:${action}_select`, 'Choisissez un membre')],
          ...ephemeral,
        });
        return;
      }

      case 'reserve': {
        await interaction.reply({
          content: '🛡️ **Réserver le salon pour un rôle** :\nSélectionnez le rôle qui sera autorisé à rejoindre votre salon vocal. Ne sélectionnez rien pour réinitialiser.',
          components: [
            new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
              new RoleSelectMenuBuilder()
                .setCustomId('tempvoice:reserve_select')
                .setPlaceholder('Sélectionnez un rôle pour réserver le salon')
                .setMinValues(0)
                .setMaxValues(1),
            ),
          ],
          ...ephemeral,
        });
        return;
      }

      default:
        return;
    }
  }

  // ---------------------------------------------------------------------------
  // Reservation par role
  // ---------------------------------------------------------------------------
  if (interaction.isRoleSelectMenu() && action === 'reserve_select') {
    const selectedRoleId = interaction.values[0] ?? null;
    const stored = await prisma.tempVoiceChannel.findUnique({ where: { id: channel.id } }).catch(() => null);

    // La reservation precedente laissait sa surcharge derriere elle : au bout
    // de quelques changements, le salon portait la liste de tous les roles
    // reserves depuis sa creation.
    if (stored?.roleId && stored.roleId !== selectedRoleId) {
      await channel.permissionOverwrites.delete(stored.roleId, 'Réservation précédente levée').catch(() => null);
    }

    if (selectedRoleId) {
      await channel.permissionOverwrites.edit(guildId, CHANNEL_PATCHES.lock);
      await channel.permissionOverwrites.edit(cache.creatorId, { ViewChannel: true, Connect: true, Speak: true });
      await channel.permissionOverwrites.edit(selectedRoleId, { ViewChannel: true, Connect: true, Speak: true });
      await prisma.tempVoiceChannel.update({ where: { id: channel.id }, data: { roleId: selectedRoleId } }).catch(() => null);
      await reply(`🛡️ Le salon est réservé au rôle <@&${selectedRoleId}>. Seuls ses membres et vous pouvez le rejoindre.`);
      return;
    }

    await channel.permissionOverwrites.edit(guildId, CHANNEL_PATCHES.clearReservation);
    await prisma.tempVoiceChannel.update({ where: { id: channel.id }, data: { roleId: null } }).catch(() => null);
    await reply("🔓 Réservation annulée : le salon retrouve l'accès prévu par sa catégorie.");
    return;
  }

  // ---------------------------------------------------------------------------
  // Actions visant un membre
  // ---------------------------------------------------------------------------
  if (interaction.isUserSelectMenu()) {
    const targetId = interaction.values[0];
    if (!targetId) {
      await reply('❌ Aucun membre sélectionné.');
      return;
    }

    const target = await guild.members.fetch(targetId).catch(() => null);
    if (!target) {
      await reply('❌ Membre introuvable sur le serveur.');
      return;
    }

    if (target.id === cache.creatorId) {
      await reply('❌ Le propriétaire du salon ne peut pas être ciblé.');
      return;
    }

    switch (action) {
      case 'transfer_select': {
        await transferOwnership(ctx, target, 'transfer');
        return;
      }

      case 'trust_select': {
        await channel.permissionOverwrites.edit(target.id, { ViewChannel: true, Connect: true, Speak: true });
        await reply(`➕ **${target.displayName}** a été autorisé à rejoindre le salon.`);
        return;
      }

      case 'kick_select': {
        if (await isProtectedTarget(guildId, target)) {
          await reply('❌ Vous ne pouvez pas exclure un membre du staff.');
          return;
        }
        if (target.voice.channelId !== channel.id) {
          await reply("❌ Ce membre n'est pas dans votre salon vocal.");
          return;
        }
        await target.voice.disconnect('Expulsé du salon vocal temporaire par le propriétaire.');
        await reply(`👢 **${target.displayName}** a été expulsé du salon vocal.`);
        return;
      }

      case 'ban_select': {
        if (await isProtectedTarget(guildId, target)) {
          await reply('❌ Vous ne pouvez pas bannir un membre du staff.');
          return;
        }
        await channel.permissionOverwrites.edit(target.id, CHANNEL_PATCHES.ban);
        if (target.voice.channelId === channel.id) {
          await target.voice.disconnect('Banni du salon vocal temporaire par le propriétaire.').catch(() => null);
        }
        await reply(`🚫 **${target.displayName}** a été banni du salon, chat écrit compris.`);
        return;
      }

      default:
        return;
    }
  }

  // ---------------------------------------------------------------------------
  // Saisies
  // ---------------------------------------------------------------------------
  if (interaction.isModalSubmit()) {
    const value = interaction.fields.getTextInputValue('value').trim();

    if (action === 'limit_modal') {
      const limit = Number.parseInt(value, 10);
      if (!Number.isFinite(limit) || limit < 0 || limit > 99) {
        await reply('❌ Nombre invalide (doit être entre 0 et 99).');
        return;
      }
      await channel.setUserLimit(limit);
      await reply(`👥 Limite fixée à ${limit === 0 ? 'illimité' : limit} membres.`);
      return;
    }

    if (action === 'rename_modal') {
      if (!value) {
        await reply('❌ Le nom ne peut pas être vide.');
        return;
      }

      // Discord n'accepte que deux renommages par tranche de dix minutes. Le
      // troisieme expirait en silence pendant que le bot annoncait un succes :
      // le proprietaire croyait son salon renomme et ne comprenait pas.
      const renamed = await channel
        .setName(value.slice(0, 100))
        .then(() => true)
        .catch(() => false);

      await reply(
        renamed
          ? `✏️ Salon renommé en : **${value.slice(0, 100)}**`
          : '❌ Discord a refusé le renommage. Un salon ne peut être renommé que deux fois par tranche de dix minutes : réessayez plus tard.',
      );
      return;
    }
  }
}

/**
 * Passe la propriete d'un salon a un autre membre.
 *
 * Le changement etait tenu en memoire seulement : au redemarrage du bot, la
 * base rendait le salon a son createur d'origine, qui pouvait etre parti depuis
 * longtemps. L'ancien proprietaire gardait par ailleurs ses pouvoirs de
 * moderation vocale sur un salon qui n'etait plus le sien.
 */
async function transferOwnership(
  ctx: ActionContext,
  target: GuildMember | null,
  kind: 'claim' | 'transfer',
): Promise<void> {
  const { interaction, channel, cache, guildId } = ctx;
  if (!target || !interaction.isRepliable()) return;

  const previousOwnerId = cache.creatorId;

  // Les pouvoirs suivent le salon, pas la configuration courante : la politique
  // du generateur a pu changer depuis, ou le generateur disparaitre. Si la
  // surcharge de l'ancien proprietaire a ete effacee a la main, on retombe sur
  // la politique du generateur principal du serveur.
  const previousOverwrite = channel.permissionOverwrites.cache.get(previousOwnerId);
  let powers = previousOverwrite ? ownerPowersFromBits(previousOverwrite.allow.bitfield) : [];

  if (!previousOverwrite) {
    const guildConfig = await getCachedGuild(guildId);
    const generators = guildConfig
      ? resolveTempVoiceGenerators(guildConfig as unknown as TempVoiceGuildConfig)
      : [];
    powers = generators[0]?.policy.ownerPowers ?? [];
  }

  await channel.permissionOverwrites.edit(target.id, ownerPermissionPatch(powers));

  if (previousOwnerId !== target.id) {
    await channel.permissionOverwrites
      .edit(previousOwnerId, ownerRevokedPermissions())
      .catch(() => null);
  }

  cache.creatorId = target.id;
  await prisma.tempVoiceChannel
    .update({ where: { id: channel.id }, data: { creatorId: target.id } })
    .catch((err: unknown) => logger.error('TempVoice', 'Propriétaire non enregistré en base :', err));

  const message = kind === 'claim'
    ? `👑 **${target.displayName}** a récupéré la propriété du salon vocal !`
    : `👑 La propriété du salon a été transférée à **${target.displayName}**.`;

  // La reprise est annoncee a tout le salon : les occupants doivent savoir qui
  // decide desormais. Le transfert, lui, reste une reponse au proprietaire.
  await (kind === 'claim'
    ? interaction.reply({ content: message }).catch(() => null)
    : interaction.reply({ content: message, flags: [MessageFlags.Ephemeral] }).catch(() => null));
}
