import { EmbedBuilder, Events, PermissionFlagsBits, type Client, type GuildMember } from 'discord.js';
import { isNicknameProblematic, isSafeNickname, safeNickname, buildRenameReason, loadBannedWords } from '../services/moderation/nicknameModerationService.js';
import { invalidateBannedWordsCache, loadGlobalWords, loadCustomWords } from '../services/moderation/bannedWordsService.js';
import { logger } from '../utils/logger.js';
import { admitJoiningMember } from '../services/moderation/joinAdmissionService.js';
import { resolveGuildLocale } from '../utils/i18n.js';
import * as m from '../lib/paraglide/messages.js';

import { getCachedGuild, cache } from '../utils/cache.js';
import { resolveEventLogChannel } from '../utils/logDispatch.js';

// ---------------------------------------------------------------------------
// Cache du statut d'activation par serveur (TTL 60s)
// ---------------------------------------------------------------------------

type NicknameModConfig = {
  enabled: boolean;
  whitelist: string[];
  bypass: string[];
  onJoin: boolean;
  onUpdate: boolean;
  checkInvisible: boolean;
  checkGlobal: boolean;
  checkCustom: boolean;
};

/**
 * Invalide uniquement le cache de configuration de modération de pseudos.
 * Pour les mots bannis, utiliser invalidateBannedWordsCache depuis bannedWordsService.
 */
export function invalidateNicknameModerationCache(guildId?: string): void {
  if (guildId) {
    cache.invalidateGuild(guildId);
    invalidateBannedWordsCache(guildId);
    return;
  }
  invalidateBannedWordsCache();
}

// Re-export pour les usages existants dans dashboardApi.ts
export { invalidateBannedWordsCache };

async function getNicknameModerationConfig(guildId: string): Promise<NicknameModConfig> {
  const guild = await getCachedGuild(guildId);

  return {
    enabled: guild?.autoNicknameModerationEnabled ?? false,
    whitelist: guild?.nicknameModerationWhitelist ?? [],
    bypass: guild?.nicknameModerationBypass ?? [],
    onJoin: guild?.nickModOnJoin ?? true,
    onUpdate: guild?.nickModOnUpdate ?? true,
    checkInvisible: guild?.nickModCheckInvisible ?? true,
    checkGlobal: guild?.nickModCheckGlobal ?? true,
    checkCustom: guild?.nickModCheckCustom ?? true,
  };
}

// ---------------------------------------------------------------------------
// Logique principale de vérification + renommage
// ---------------------------------------------------------------------------

async function checkAndRename(member: GuildMember): Promise<void> {
  if (member.user.bot) return;

  const guildId = member.guild.id;
  const config = await getNicknameModerationConfig(guildId);
  if (!config.enabled) return;

  // Vérification des permissions du bot
  const botMember = member.guild.members.me ?? await member.guild.members.fetchMe().catch(() => null);
  if (!botMember) return;
  if (!botMember.permissions.has(PermissionFlagsBits.ManageNicknames)) return;

  // `manageable` couvre d'un coup le proprietaire du serveur, la hierarchie des
  // roles et les membres que le bot ne peut pas toucher.
  if (!member.manageable) return;

  // Pseudo effectif : nickname > globalName > username
  const effectiveName = member.nickname ?? member.user.globalName ?? member.user.username;
  if (!effectiveName) return;

  if (isSafeNickname(effectiveName)) return;

  // Chargement des mots bannis selon les toggles actifs
  let bannedWords: string[] = [];
  if (config.checkGlobal && config.checkCustom) {
    bannedWords = await loadBannedWords(guildId);
  } else if (config.checkGlobal) {
    bannedWords = await loadGlobalWords();
  } else if (config.checkCustom) {
    bannedWords = await loadCustomWords(guildId);
  }

  if (
    !isNicknameProblematic(effectiveName, bannedWords, {
      whitelist: config.whitelist,
      userId: member.id,
      bypassUserIds: config.bypass,
      checkInvisible: config.checkInvisible,
    })
  ) {
    return;
  }

  const locale = await resolveGuildLocale(guildId, member.guild.preferredLocale);
  const safe = safeNickname(locale);

  try {
    await member.setNickname(safe, buildRenameReason(effectiveName, locale));

    logger.warn(
      'NicknameAutomod',
      `Pseudo renommé pour ${member.user.tag} dans "${member.guild.name}": "${effectiveName}" → "${safe}"`,
    );

    // Log dans le channel de logs du serveur
    const { default: prisma } = await import('../utils/db.js');
    const guildData = await prisma.guild.findUnique({
      where: { id: guildId },
      select: { logChannelId: true },
    });

    {
      const logChannel = await resolveEventLogChannel(member.guild, 'automod_nickname', 'NicknameAutomod');
      if (logChannel) {
        const embed = new EmbedBuilder()
          .setColor(0xf4a261)
          .setTitle(m.nickmod_log_title_auto({}, { locale }))
          .addFields(
            { name: m.nickmod_log_member({}, { locale }), value: `<@${member.id}> \`${member.user.tag}\``, inline: false },
            { name: m.nickmod_log_original({}, { locale }), value: `\`${effectiveName}\``, inline: true },
            { name: m.nickmod_log_applied({}, { locale }), value: `\`${safe}\``, inline: true },
          )
          .setThumbnail(member.displayAvatarURL())
          .setFooter({ text: m.nickmod_log_footer_auto({}, { locale }) })
          .setTimestamp();

        await logChannel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
      }
    }

    // Audit dashboard
    await prisma.dashboardAuditLog.create({
      data: {
        guildId,
        channelId: guildData?.logChannelId ?? null,
        user: 'Automod',
        action: 'Renommage automatique de pseudo',
        context: member.guild.name,
        module: 'Modération des pseudos',
        eventType: 'Automatique',
        details: `Pseudo "${effectiveName}" remplacé par "${safe}" pour ${member.user.tag}`,
        dateIso: new Date(),
      },
    }).catch(() => null);
  } catch (error) {
    logger.error('NicknameAutomod', `Impossible de renommer ${member.user.tag}:`, error);
  }
}

// ---------------------------------------------------------------------------
// Enregistrement des listeners
// ---------------------------------------------------------------------------

export function registerNicknameModerationListener(client: Client): void {
  client.on(Events.GuildMemberAdd, async (member) => {
    try {
      if (!(await admitJoiningMember(member))) return;
      const config = await getNicknameModerationConfig(member.guild.id);
      if (!config.enabled || !config.onJoin) return;
      await checkAndRename(member);
    } catch (err) {
      logger.error('NicknameAutomod', 'Erreur GuildMemberAdd:', err);
    }
  });

  client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    if (oldMember.partial || newMember.partial) return;

    const oldName = oldMember.nickname ?? oldMember.user.globalName ?? oldMember.user.username;
    const newName = newMember.nickname ?? newMember.user.globalName ?? newMember.user.username;

    if (oldName === newName) return;
    if (isSafeNickname(newName)) return;

    try {
      const config = await getNicknameModerationConfig(newMember.guild.id);
      if (!config.enabled || !config.onUpdate) return;
      await checkAndRename(newMember);
    } catch (err) {
      logger.error('NicknameAutomod', 'Erreur GuildMemberUpdate:', err);
    }
  });

  logger.success('NicknameAutomod', 'Listener de modération des pseudos enregistré.');
}
