import { type Client, Events, type GuildBasedChannel, type GuildMember, type Invite, type Message, type PartialGuildMember, type Typing, type VoiceState } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getRaidProtectionConfig } from '../services/moderation/raidProtectionService.js';
import { admitJoiningMember } from '../services/moderation/joinAdmissionService.js';
import { startCaptchaChallenge, handleCaptchaMessage, hasPendingCaptchaSession } from '../services/moderation/captchaService.js';
import { restorePersistedRoles, snapshotDepartingMemberRoles } from '../services/moderation/rolePersistenceService.js';
import { handleScamMessage } from '../services/moderation/scamFilterService.js';
import { handleVision } from '../services/moderation/visionService.js';
import { syncMemberTagRole } from '../services/moderation/tagRoleService.js';
import { handleInviteCreate } from '../services/moderation/inviteGuardService.js';
import { handleVoiceStateUpdate } from '../services/moderation/voiceCaptchaService.js';
import { handleSpamMessage, handleTypingStart } from '../services/moderation/spam/index.js';
import { applyJailOverwrite, reapplyJailOnJoin, syncDiscordQuarantine } from '../services/moderation/jailService.js';
import { decideCaptcha } from '../services/moderation/captchaTrigger.js';
import { handleOtherServersMessage, syncServerTagQuarantine } from '../services/moderation/otherServersFilter.js';
import { handleFileExtensionMessage } from '../services/moderation/fileExtensionFilter.js';

export function registerRaidProtectionListener(client: Client): void {
  // ── Arrivées : join lock → raid kick → détection de raid → ancienneté → captcha → rôles rendus → tag role
  client.on(Events.GuildMemberAdd, async (member: GuildMember) => {
    try {
      // 1 à 4. Join lock, raid kick, détection de raid, ancienneté du compte : partagés
      //        avec les autres écouteurs d'arrivée, qui attendent ce verdict avant d'agir.
      if (!(await admitJoiningMember(member))) return;

      const config = await getRaidProtectionConfig(member.guild.id);
      if (!config) return;

      // Quarantaine toujours active : partir et revenir ne la lève pas. Ni
      // captcha ni rôles rendus, ils annuleraient la quarantaine.
      if (await reapplyJailOnJoin(member)) return;

      // 5. Captcha : selon son déclenchement (permanent, automatique,
      //    intelligent), le raid mode et le niveau Shield, qui passe avant.
      const captcha = decideCaptcha(member, config);
      if (captcha.challenge) {
        await startCaptchaChallenge(member, config, { frozen: captcha.frozen });
      }

      // 6. Rôles rendus au retour : un captcha en cours les diffère jusqu'à sa réussite
      if (config.rolePersistEnabled && !(await hasPendingCaptchaSession(member.guild.id, member.id))) {
        await restorePersistedRoles(member, config);
      }

      // 7. Tag role (si le membre arrive déjà avec le tag du serveur)
      await syncMemberTagRole(member, config);
      await syncServerTagQuarantine(member, config);
      await syncDiscordQuarantine(member, config);
    } catch (err) {
      logger.error('RaidProtection', `Erreur GuildMemberAdd pour ${member.id}`, err);
    }
  });

  // ── Nouveaux salons : masqués aux membres en quarantaine ────────────────────
  client.on(Events.ChannelCreate, async (channel: GuildBasedChannel) => {
    try {
      const config = await getRaidProtectionConfig(channel.guild.id);
      if (!config?.jailRoleId) return;
      // Un salon qui hérite de sa catégorie en a déjà le refus.
      if ('permissionsLocked' in channel && channel.permissionsLocked && channel.parentId) return;
      await applyJailOverwrite(channel, config.jailRoleId, config.jailChannelId);
    } catch (err) {
      logger.debug('RaidProtection', `Refus Jail non posé sur le salon ${channel.id}: ${String(err)}`);
    }
  });

  // ── Départs : mémorisation des rôles pour les rendre au retour ──────────────
  client.on(Events.GuildMemberRemove, async (member: GuildMember | PartialGuildMember) => {
    try {
      const config = await getRaidProtectionConfig(member.guild.id);
      if (!config) return;
      await snapshotDepartingMemberRoles(member, config);
    } catch (err) {
      logger.error('RaidProtection', `Erreur GuildMemberRemove pour ${member.id}`, err);
    }
  });

  // ── Messages : réponse captcha, filtre anti-scam, moteur anti-spam ──────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (!message.guild || message.author.bot) return;
    try {
      // Le salon captcha consomme le message (comparaison du code + nettoyage)
      if (await handleCaptchaMessage(message)) return;
      // Kotbo Vision puis le filtre anti-scam passent avant : une image ou un lien
      // d'arnaque identifié est une certitude, là où le moteur anti-spam
      // raisonne en probabilité.
      // Filtres de l'Automod : invitations et liens d'autres serveurs, fichiers.
      if (await handleOtherServersMessage(message)) return;
      if (await handleFileExtensionMessage(message)) return;
      if (await handleVision(message)) return;
      if (await handleScamMessage(message)) return;
      await handleSpamMessage(message);
    } catch (err) {
      logger.error('RaidProtection', `Erreur MessageCreate`, err);
    }
  });

  // ── Frappe : alimente le signal « message posté sans indicateur de frappe » ──
  client.on(Events.TypingStart, (typing: Typing) => {
    if (!typing.guild || typing.user.bot) return;
    handleTypingStart(typing.guild.id, typing.user.id);
  });

  // ── Invitations : urgence, règle unitaire, validation staff, anti-spam ──────
  client.on(Events.InviteCreate, async (invite: Invite) => {
    try {
      await handleInviteCreate(invite);
    } catch (err) {
      logger.error('RaidProtection', `Erreur InviteCreate (${invite.code})`, err);
    }
  });

  // ── Vocal : entrée/sortie de la file du captcha vocal ───────────────────────
  client.on(Events.VoiceStateUpdate, async (oldState: VoiceState, newState: VoiceState) => {
    try {
      await handleVoiceStateUpdate(oldState, newState);
    } catch (err) {
      logger.error('RaidProtection', 'Erreur VoiceStateUpdate (captcha vocal)', err);
    }
  });

  // ── Mise à jour de membre : synchronisation du tag role ─────────────────────
  client.on(Events.GuildMemberUpdate, async (_old: GuildMember | PartialGuildMember, member: GuildMember) => {
    try {
      await syncMemberTagRole(member);
      await syncServerTagQuarantine(member);
      await syncDiscordQuarantine(member);
    } catch (err) {
      logger.error('RaidProtection', `Erreur GuildMemberUpdate pour ${member.id}`, err);
    }
  });

  // Même mise à jour, pour un membre que discord.js n'avait pas en cache : elle
  // n'émet pas GuildMemberUpdate et le tag posé passait inaperçu.
  client.on(Events.GuildMemberAvailable, async (member: GuildMember | PartialGuildMember) => {
    try {
      if (member.partial) return;
      await syncMemberTagRole(member);
      await syncServerTagQuarantine(member);
      await syncDiscordQuarantine(member);
    } catch (err) {
      logger.error('RaidProtection', `Erreur GuildMemberAvailable pour ${member.id}`, err);
    }
  });
}
