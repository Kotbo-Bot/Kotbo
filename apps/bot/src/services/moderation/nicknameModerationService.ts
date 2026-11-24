/**
 * Service de modération automatique des pseudos Discord.
 * Délègue la détection des mots bannis à bannedWordsService (service générique partagé).
 */

import { EmbedBuilder, PermissionFlagsBits, type Guild } from 'discord.js';
import { containsBannedWord, INVISIBLE_ONLY_REGEX, loadBannedWords, loadGlobalWords, loadCustomWords } from './bannedWordsService.js';
import { logger } from '../../utils/logger.js';
import { fetchAllMembers } from '../../utils/discord.js';
import type { BotLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { resolveEventLogChannel } from '../../utils/logDispatch.js';

export { loadBannedWords, invalidateBannedWordsCache } from './bannedWordsService.js';

/** Limite Discord : un pseudo au-dela est refuse par l'API. */
const NICKNAME_MAX_LENGTH = 32;

function clampNickname(value: string): string {
  return value.trim().slice(0, NICKNAME_MAX_LENGTH);
}

// `Record<BotLocale, …>` : ajouter une langue sans la declarer ici casse le
// typecheck. Sans cette exhaustivite, les pseudos deja remplaces dans la langue
// oubliee redeviendraient « non conformes » et seraient renommes en masse.
const SAFE_NICKNAMES: Record<BotLocale, string> = {
  fr: clampNickname(m.nickmod_safe_nickname({}, { locale: 'fr' })),
  en: clampNickname(m.nickmod_safe_nickname({}, { locale: 'en' })),
};

/** Pseudo de remplacement applique automatiquement, dans la langue du serveur. */
export function safeNickname(locale: BotLocale): string {
  return SAFE_NICKNAMES[locale];
}

// Toutes les langues, pas seulement celle du serveur : sans ca, changer la
// langue rendrait « non conformes » tous les pseudos deja remplaces et
// declencherait une vague de renommages au premier evenement venu.
const KNOWN_SAFE_NICKNAMES: ReadonlySet<string> = new Set(
  Object.values(SAFE_NICKNAMES).map((nickname) => nickname.toLowerCase()),
);

/** Un pseudo deja pose par la moderation, quelle que soit la langue du serveur. */
export function isSafeNickname(name: string): boolean {
  return KNOWN_SAFE_NICKNAMES.has(name.toLowerCase().trim());
}

// Fragments du pseudo de remplacement, dans toutes les langues : « pseudo non
// conforme », « non-compliant nickname » et « automod ». Les decouper sur la
// barre verticale evite de lister ces morceaux a la main, donc d'en oublier un
// en ajoutant une langue.
const RESERVED_FRAGMENTS: readonly string[] = [
  ...new Set(
    Object.values(SAFE_NICKNAMES)
      .flatMap((nickname) => nickname.split('|'))
      .map((fragment) => fragment.trim().toLowerCase())
      .filter(Boolean),
  ),
];

/**
 * Un mot banni recouvrant le pseudo de remplacement retournerait la moderation
 * contre elle-meme : le pseudo pose serait a son tour signale.
 */
export function isReservedByNicknameModeration(word: string): boolean {
  const normalized = word.trim().toLowerCase();
  if (!normalized) return false;
  return RESERVED_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/**
 * Vérifie si un pseudo est non conforme.
 *
 * @param name  Le pseudo brut (nickname, globalName ou username) à analyser.
 * @param words Liste de mots bannis chargée via `loadBannedWords(guildId)`.
 * @returns `true` si le pseudo doit être remplacé.
 */
export function isNicknameProblematic(
  name: string,
  words: string[],
  options?: {
    whitelist?: string[];
    userId?: string;
    bypassUserIds?: string[];
    checkInvisible?: boolean;
  }
): boolean {
  if (!name || name.trim().length === 0) return true;
  if ((options?.checkInvisible ?? true) && INVISIBLE_ONLY_REGEX.test(name)) return true;

  const normalized = name.toLowerCase().trim();

  // Protection anti-boucle : ignorer uniquement les pseudos de remplacement exacts
  if (isSafeNickname(normalized)) {
    return false;
  }

  // Membre exempté (Bypass par ID utilisateur)
  if (options?.userId && options.bypassUserIds?.includes(options.userId)) {
    return false;
  }

  // Pseudo sur la whitelist du serveur (comparaison exacte insensible à la casse)
  if (options?.whitelist) {
    const isWhitelisted = options.whitelist.some(
      (w) => typeof w === 'string' && w.trim().toLowerCase() === normalized
    );
    if (isWhitelisted) return false;
  }

  return containsBannedWord(name, words);
}

/**
 * Retourne une raison de renommage lisible dans les logs d'audit Discord.
 */
export function buildRenameReason(originalName: string, locale: BotLocale): string {
  return m.nickmod_rename_reason({ original: originalName }, { locale });
}

// ---------------------------------------------------------------------------
// Résultat du scan massif
// ---------------------------------------------------------------------------

export type PseudoScanResult = {
  scannedCount: number;
  renamedCount: number;
  skippedCount: number;  // bots, owner, sans permission
  errorCount: number;
  renamed: Array<{ userId: string; original: string }>;
};

/**
 * Scanne TOUS les membres du serveur et renomme ceux dont le pseudo est non conforme.
 * Envoie un log dans le channel de logs du serveur pour chaque renommage.
 *
 * @param guild  Le serveur Discord à scanner.
 * @returns Un résumé du scan.
 */
export async function scanAndModeratePseudos(guild: Guild): Promise<PseudoScanResult> {
  const { default: prisma } = await import('../../utils/db.js');

  const result: PseudoScanResult = {
    scannedCount: 0,
    renamedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    renamed: [],
  };

  // Vérification des permissions du bot
  const botMember = await guild.members.fetchMe().catch(() => null);
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageNicknames)) {
    logger.warn('NicknameRescan', `Pas la permission ManageNicknames sur "${guild.name}"`);
    return result;
  }

  // Charger le channel de logs et la configuration de la whitelist/bypass/toggles
  const guildData = await prisma.guild.findUnique({
    where: { id: guild.id },
    select: {
      logChannelId: true,
      nicknameModerationWhitelist: true,
      nicknameModerationBypass: true,
      nickModCheckInvisible: true,
      nickModCheckGlobal: true,
      nickModCheckCustom: true,
    },
  }).catch(() => null);

  const logChannel = await resolveEventLogChannel(guild, 'automod_nickname', 'NicknameRescan');

  // Charger les mots bannis selon les toggles actifs
  const checkGlobal = guildData?.nickModCheckGlobal ?? true;
  const checkCustom = guildData?.nickModCheckCustom ?? true;
  const checkInvisible = guildData?.nickModCheckInvisible ?? true;
  let bannedWords: string[] = [];
  if (checkGlobal && checkCustom) {
    bannedWords = await loadBannedWords(guild.id);
  } else if (checkGlobal) {
    bannedWords = await loadGlobalWords();
  } else if (checkCustom) {
    bannedWords = await loadCustomWords(guild.id);
  }

  // Récupérer tous les membres
  const members = await fetchAllMembers(guild).catch(() => null);
  if (!members) return result;

  const whitelist = guildData?.nicknameModerationWhitelist ?? [];
  const bypass = guildData?.nicknameModerationBypass ?? [];
  // Import differe comme celui de Prisma juste au-dessus : `utils/i18n` tire le
  // cache Redis et la base, dont ce module n'a pas besoin pour ses fonctions
  // pures (celles que couvrent les tests unitaires).
  const { resolveGuildLocale } = await import('../../utils/i18n.js');
  const locale = await resolveGuildLocale(guild.id, guild.preferredLocale);
  const safe = safeNickname(locale);

  for (const [, member] of members) {
    if (member.user.bot) { result.skippedCount++; continue; }
    // `manageable` couvre d'un coup le proprietaire, la hierarchie des roles et
    // les membres que le bot ne peut pas toucher.
    if (!member.manageable) { result.skippedCount++; continue; }

    result.scannedCount++;

    const effectiveName = member.nickname ?? member.user.globalName ?? member.user.username;
    if (!effectiveName) { result.skippedCount++; continue; }

    // Déjà au pseudo de sécurité → skip
    if (isSafeNickname(effectiveName)) continue;

    if (!isNicknameProblematic(effectiveName, bannedWords, { whitelist, userId: member.id, bypassUserIds: bypass, checkInvisible })) continue;

    try {
      await member.setNickname(safe, buildRenameReason(effectiveName, locale));
      result.renamedCount++;
      result.renamed.push({ userId: member.id, original: effectiveName });

      // Petite pause pour éviter de saturer la rate-limit de Discord (max ~10 requêtes par 10 secondes)
      await new Promise((resolve) => setTimeout(resolve, 200));

      logger.warn(
        'NicknameRescan',
        `Pseudo renommé: ${member.user.tag} - "${effectiveName}" → "${safe}"`,
      );

      // Log embed dans le channel de logs
      if (logChannel) {
        const embed = new EmbedBuilder()
          .setColor(0xf4a261)
          .setTitle(m.nickmod_log_title_rescan({}, { locale }))
          .addFields(
            { name: m.nickmod_log_member({}, { locale }), value: `<@${member.id}> \`${member.user.tag}\``, inline: false },
            { name: m.nickmod_log_original({}, { locale }), value: `\`${effectiveName}\``, inline: true },
            { name: m.nickmod_log_applied({}, { locale }), value: `\`${safe}\``, inline: true },
          )
          .setThumbnail(member.displayAvatarURL())
          .setFooter({ text: m.nickmod_log_footer_rescan({}, { locale }) })
          .setTimestamp();

        await logChannel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
      }

      // Audit dashboard
      await prisma.dashboardAuditLog.create({
        data: {
          guildId: guild.id,
          channelId: guildData?.logChannelId ?? null,
          user: 'Automod (Rescan)',
          action: 'Renommage automatique de pseudo (rescan)',
          context: guild.name,
          module: 'Modération des pseudos',
          eventType: 'Manuel',
          details: `Pseudo "${effectiveName}" remplacé par "${safe}" pour ${member.user.tag}`,
          dateIso: new Date(),
        },
      }).catch(() => null);
    } catch (error) {
      result.errorCount++;
      logger.error('NicknameRescan', `Impossible de renommer ${member.user.tag}:`, error);
    }
  }

  return result;
}
