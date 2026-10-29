import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ChannelType,
  BaseInteraction,
  PermissionFlagsBits,
  type Client,
  type TextChannel,
  StringSelectMenuBuilder,
} from 'discord.js';
import prisma from '../utils/db.js';
import { COLORS } from '../utils/embeds.js';
import { acknowledgeInteraction, renderPanelTarget } from '../utils/interactionResponses.js';
import { getRaidProtectionConfig, upsertRaidProtectionConfig } from '../services/moderation/raidProtectionService.js';
import { provisionJail } from '../services/moderation/jailService.js';
import { createShieldPanelChannel, postShieldPanel } from '../services/moderation/shieldService.js';
import { honeypotChannelName, provisionHoneypotChannel } from '../services/moderation/honeypotProvisioning.js';
import { resolveGuildLocale } from '../utils/i18n.js';

export async function sendSetupWelcome(
  client: Client,
  guildId: string,
  target: TextChannel | BaseInteraction,
): Promise<void> {
  if (target instanceof BaseInteraction) {
    await acknowledgeInteraction(target);
  }
  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('🚀 Bienvenue sur Kotbo !')
    .setDescription(
      "Merci d'avoir choisi Kotbo. Ce guide va vous aider à configurer le bot étape par étape.\n\n" +
      "**Au programme :**\n" +
      "1️⃣ Salons de base (Config & Public)\n" +
      "2️⃣ Rôle Modérateur (Optionnel)\n" +
      "3️⃣ Auto-traduction (Optionnel)\n" +
      "4️⃣ Protection & sécurité (Diagnostic, Jail, Honeypot, Shield, Captcha, Kotbo Vision)\n\n" +
      "Cliquez sur le bouton ci-dessous pour commencer, ou accédez directement à l'assistant sécurité."
    )
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('setup:step1')
      .setLabel('Commencer la configuration')
      .setStyle(ButtonStyle.Success)
      .setEmoji('🏁'),
    new ButtonBuilder()
      .setCustomId('setup:step4')
      .setLabel('Protection & sécurité')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🛡️'),
  );

  await renderPanelTarget(target, { embeds: [embed], components: [row] });
}

export async function sendSetupStep1(
  client: Client,
  guildId: string,
  target: TextChannel | BaseInteraction,
): Promise<void> {
  if (target instanceof BaseInteraction) {
    await acknowledgeInteraction(target);
  }
  const guild = await prisma.guild.findUnique({ where: { id: guildId } });
  
  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('Étape 1 : Salons de base')
    .setDescription(
      "Nous avons besoin de deux salons principaux pour le fonctionnement global :\n\n" +
      "**1. Salon de Config/Modération :** Où les alertes de gestion arrivent.\n" +
      "**2. Salon Public :** Le salon principal pour les annonces automatiques.\n\n" +
      (guild?.configChannelId && guild?.publicChannelId 
        ? `✅ Actuellement configuré :\n- Config : <#${guild.configChannelId}>\n- Public : <#${guild.publicChannelId}>` 
        : "Veuillez sélectionner les salons ci-dessous.")
    );

  const configSelect = new ChannelSelectMenuBuilder()
    .setCustomId('setup:select_config_channel')
    .setPlaceholder('Sélectionner le salon de CONFIG...')
    .addChannelTypes(ChannelType.GuildText);

  const publicSelect = new ChannelSelectMenuBuilder()
    .setCustomId('setup:select_public_channel')
    .setPlaceholder('Sélectionner le salon PUBLIC...')
    .addChannelTypes(ChannelType.GuildText);

  const row1 = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(configSelect);
  const row2 = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(publicSelect);
  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('setup:step2')
      .setLabel('Suivant')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!guild?.configChannelId || !guild?.publicChannelId)
  );

  await renderPanelTarget(target, { embeds: [embed], components: [row1, row2, row3] });
}

export async function sendSetupStep2(
  client: Client,
  guildId: string,
  target: TextChannel | BaseInteraction,
): Promise<void> {
  if (target instanceof BaseInteraction) {
    await acknowledgeInteraction(target);
  }
  const guild = await prisma.guild.findUnique({ where: { id: guildId } });

  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('Étape 2 : Rôle Modérateur')
    .setDescription(
      "Par défaut, seuls les administrateurs peuvent configurer le bot.\n" +
      "Vous pouvez définir un rôle spécifique dont les membres pourront aussi accéder aux commandes staff.\n\n" +
      (guild?.moderatorRoleId 
        ? `✅ Rôle actuel : <@&${guild.moderatorRoleId}>` 
        : "Aucun rôle configuré (Admin uniquement).")
    );

  const select = new RoleSelectMenuBuilder()
    .setCustomId('setup:select_mod_role')
    .setPlaceholder('Sélectionner un rôle (optionnel)...');

  const row1 = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(select);
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('setup:step1').setLabel('Précédent').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:step3').setLabel('Suivant').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('setup:reset_mod_role').setLabel('Réinitialiser').setStyle(ButtonStyle.Danger)
  );

  await renderPanelTarget(target, { embeds: [embed], components: [row1, row2] });
}

export async function sendSetupStep3(
  client: Client,
  guildId: string,
  target: TextChannel | BaseInteraction,
): Promise<void> {
  if (target instanceof BaseInteraction) {
    await acknowledgeInteraction(target);
  }
  const guild = await prisma.guild.findUnique({ where: { id: guildId } });

  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('Étape 3 : Auto-traduction')
    .setDescription(
      "Kotbo peut traduire automatiquement les contenus étrangers vers une langue cible.\n\n" +
      `Statut actuel : **${guild?.translationEnabled ? '🟢 Activé' : '🔴 Désactivé'}**\n` +
      `Langue cible : **${guild?.defaultTranslateTo ?? 'FR'}**`
    );

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('setup:trans_toggle')
      .setLabel(guild?.translationEnabled ? 'Désactiver la traduction' : 'Activer la traduction')
      .setStyle(guild?.translationEnabled ? ButtonStyle.Danger : ButtonStyle.Success)
  );

  const langSelect = new StringSelectMenuBuilder()
    .setCustomId('setup:trans_lang')
    .setPlaceholder('Langue cible...')
    .addOptions([
      { label: 'Français', value: 'FR', emoji: '🇫🇷' },
      { label: 'English', value: 'EN', emoji: '🇬🇧' },
      { label: 'Español', value: 'ES', emoji: '🇪🇸' },
      { label: 'Deutsch', value: 'DE', emoji: '🇩🇪' },
    ]);

  const rowLang = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(langSelect);
  const rowNav = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('setup:step2').setLabel('Précédent').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:step4').setLabel('Suivant (Sécurité)').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('setup:finish').setLabel('Terminer').setStyle(ButtonStyle.Success)
  );

  await renderPanelTarget(target, { embeds: [embed], components: [row1, rowLang, rowNav] });
}

export async function sendSetupStep4(
  client: Client,
  guildId: string,
  target: TextChannel | BaseInteraction,
  notice?: string,
): Promise<void> {
  if (target instanceof BaseInteraction) {
    await acknowledgeInteraction(target);
  }
  const discordGuild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
  const [guild, rprot, autoMod] = await Promise.all([
    prisma.guild.findUnique({ where: { id: guildId } }),
    getRaidProtectionConfig(guildId),
    prisma.autoModConfig.findUnique({ where: { guildId } }),
  ]);

  const me = discordGuild?.members.me ?? null;
  const requiredPerms: [bigint, string][] = [
    [PermissionFlagsBits.ManageRoles, 'Gérer les rôles'],
    [PermissionFlagsBits.ManageChannels, 'Gérer les salons'],
    [PermissionFlagsBits.ManageMessages, 'Gérer les messages'],
    [PermissionFlagsBits.ModerateMembers, 'Exclure temporairement'],
    [PermissionFlagsBits.KickMembers, 'Expulser'],
    [PermissionFlagsBits.BanMembers, 'Bannir'],
    [PermissionFlagsBits.ViewAuditLog, 'Voir les logs d\'audit'],
  ];
  const missingPerms = me
    ? requiredPerms.filter(([bit]) => !me.permissions.has(bit)).map(([, label]) => label)
    : [];
  const totalRoles = discordGuild ? discordGuild.roles.cache.filter((r) => r.id !== guildId).size : 0;
  const botPos = me?.roles.highest.position ?? 0;

  const check = (ok: boolean) => (ok ? '🟢' : '⚪');
  const lines = [
    notice ? `> ✨ ${notice}\n` : '',
    '**Diagnostic du bot :**',
    missingPerms.length === 0
      ? `🟢 Permissions complètes · Rôle le plus haut : position **${botPos}**/${totalRoles}`
      : `🟠 Permissions manquantes : **${missingPerms.join(', ')}**`,
    '',
    '**Modules de protection (clic pour créer ou basculer) :**',
    `${check(Boolean(guild?.logChannelId))} **Salon de logs :** ${guild?.logChannelId ? `<#${guild.logChannelId}>` : 'non défini (menu ci-dessous)'}`,
    `${check(Boolean(rprot?.jailRoleId))} **Quarantaine (Jail) :** ${rprot?.jailRoleId ? `<@&${rprot.jailRoleId}>${rprot.jailChannelId ? ` · <#${rprot.jailChannelId}>` : ''}` : 'non créée'}`,
    `${check(Boolean(guild?.honeypotEnabled && guild?.honeypotChannelId))} **Salon piège (Honeypot) :** ${guild?.honeypotEnabled && guild?.honeypotChannelId ? `<#${guild.honeypotChannelId}>` : 'inactif'}`,
    `${check(Boolean(rprot?.shieldPanelChannelId))} **Panneau Shield :** ${rprot?.shieldPanelChannelId ? `<#${rprot.shieldPanelChannelId}> (niveau ${rprot.shieldLevel})` : 'non publié'}`,
    `${check(Boolean(rprot?.captchaEnabled && rprot?.captchaChannelId && rprot?.captchaUnverifiedRoleId))} **Captcha :** ${rprot?.captchaEnabled ? `actif (${rprot.captchaTrigger === 'SMART' ? 'intelligent' : rprot.captchaTrigger === 'AUTO' ? 'auto' : 'permanent'})` : 'inactif'}${rprot?.captchaChannelId ? ` · <#${rprot.captchaChannelId}>` : ''}`,
    `${check((rprot?.visionEnabled ?? true) && Boolean(rprot?.scamFilterEnabled))} **Kotbo Vision & Anti-arnaque :** Vision ${(rprot?.visionEnabled ?? true) ? 'actif' : 'inactif'} · Liens ${rprot?.scamFilterEnabled ? 'actif' : 'inactif'}`,
    `${check(Boolean(autoMod?.spamEnabled))} **Anti-spam & Slowmode préventif :** ${autoMod?.spamEnabled ? 'actif' : 'inactif'}`,
  ].filter(Boolean);

  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('Étape 4 : Protection & sécurité')
    .setDescription(lines.join('\n'));

  const logSelect = new ChannelSelectMenuBuilder()
    .setCustomId('setup:select_log_channel')
    .setPlaceholder('Choisir le salon de logs de modération...')
    .addChannelTypes(ChannelType.GuildText);

  const rowLog = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(logSelect);
  const rowActions1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('setup:sec_jail')
      .setLabel(rprot?.jailRoleId ? 'Réparer Jail' : 'Créer rôle & salon Jail')
      .setEmoji('🔒')
      .setStyle(rprot?.jailRoleId ? ButtonStyle.Secondary : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('setup:sec_honeypot')
      .setLabel(guild?.honeypotEnabled && guild?.honeypotChannelId ? 'Honeypot actif' : 'Créer le Honeypot')
      .setEmoji('🍯')
      .setStyle(guild?.honeypotEnabled && guild?.honeypotChannelId ? ButtonStyle.Secondary : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('setup:sec_shield')
      .setLabel(rprot?.shieldPanelChannelId ? 'Republier Shield' : 'Créer #shield')
      .setEmoji('🛡️')
      .setStyle(rprot?.shieldPanelChannelId ? ButtonStyle.Secondary : ButtonStyle.Primary),
  );
  const rowActions2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('setup:sec_captcha')
      .setLabel(rprot?.captchaEnabled ? 'Captcha (Intelligent)' : 'Installer Captcha')
      .setEmoji('🔐')
      .setStyle(rprot?.captchaEnabled ? ButtonStyle.Secondary : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('setup:sec_scam')
      .setLabel(rprot?.scamFilterEnabled ? 'Vision + Anti-scam actifs' : 'Activer Vision + Anti-scam')
      .setEmoji('🔍')
      .setStyle(rprot?.scamFilterEnabled ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('setup:sec_spam')
      .setLabel(autoMod?.spamEnabled ? 'Anti-spam actif' : 'Activer Anti-spam')
      .setEmoji('🐢')
      .setStyle(autoMod?.spamEnabled ? ButtonStyle.Success : ButtonStyle.Primary),
  );
  const rowNav = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('setup:step3').setLabel('Précédent').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:finish').setLabel('Terminer').setStyle(ButtonStyle.Success),
  );

  await renderPanelTarget(target, { embeds: [embed], components: [rowLog, rowActions1, rowActions2, rowNav] });
}

export async function handleSetupSecurityAction(
  client: Client,
  guildId: string,
  step: string,
  interaction: BaseInteraction,
): Promise<void> {
  const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) return;

  try {
    if (step === 'sec_jail') {
      const res = await provisionJail(guild, { createChannel: true });
      await sendSetupStep4(client, guildId, interaction, `Rôle Jail prêt (<@&${res.roleId}>), masqué sur ${res.channelsUpdated} salon(s).`);
      return;
    }

    if (step === 'sec_honeypot') {
      const existing = await prisma.guild.findUnique({ where: { id: guildId }, select: { honeypotChannelId: true } });
      let channelId = existing?.honeypotChannelId ?? null;
      if (!channelId || !guild.channels.cache.has(channelId)) {
        const locale = await resolveGuildLocale(guildId);
        const channel = await provisionHoneypotChannel(guild, {
          name: honeypotChannelName(locale),
          reason: 'Kotbo /setup : création du salon piège',
        });
        channelId = channel.id;
      }
      await prisma.guild.upsert({
        where: { id: guildId },
        create: { id: guildId, honeypotEnabled: true, honeypotChannelId: channelId, honeypotSanction: 'BAN', honeypotGraceSeconds: 60 },
        update: { honeypotEnabled: true, honeypotChannelId: channelId },
      });
      await sendSetupStep4(client, guildId, interaction, `Salon piège actif dans <#${channelId}>.`);
      return;
    }

    if (step === 'sec_shield') {
      const rprot = await getRaidProtectionConfig(guildId);
      const channelId = rprot?.shieldPanelChannelId && guild.channels.cache.has(rprot.shieldPanelChannelId)
        ? rprot.shieldPanelChannelId
        : await createShieldPanelChannel(guild);
      await postShieldPanel(guild, channelId);
      await sendSetupStep4(client, guildId, interaction, `Panneau Shield publié dans <#${channelId}>.`);
      return;
    }

    if (step === 'sec_captcha') {
      const rprot = await getRaidProtectionConfig(guildId);
      let roleId = rprot?.captchaUnverifiedRoleId && guild.roles.cache.has(rprot.captchaUnverifiedRoleId)
        ? rprot.captchaUnverifiedRoleId
        : null;
      if (!roleId) {
        const role = await guild.roles.create({
          name: 'Non vérifié',
          color: 0x95a5a6,
          permissions: [],
          reason: 'Kotbo /setup : rôle de vérification captcha',
        });
        roleId = role.id;
      }
      let channelId = rprot?.captchaChannelId && guild.channels.cache.has(rprot.captchaChannelId)
        ? rprot.captchaChannelId
        : null;
      if (!channelId) {
        const ch = await guild.channels.create({
          name: 'vérification',
          type: ChannelType.GuildText,
          permissionOverwrites: [
            { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
            { id: guild.members.me!.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ManageMessages] },
          ],
          reason: 'Kotbo /setup : salon de vérification captcha',
        });
        channelId = ch.id;
      }
      await upsertRaidProtectionConfig(guildId, {
        captchaEnabled: true,
        captchaChannelId: channelId,
        captchaUnverifiedRoleId: roleId,
        captchaTrigger: 'SMART',
        captchaUseServerIcon: true,
      });
      await sendSetupStep4(client, guildId, interaction, `Captcha intelligent activé (<#${channelId}>, rôle <@&${roleId}>).`);
      return;
    }

    if (step === 'sec_scam') {
      await upsertRaidProtectionConfig(guildId, {
        visionEnabled: true,
        scamFilterEnabled: true,
        scamQrFilterEnabled: true,
      });
      await sendSetupStep4(client, guildId, interaction, 'Kotbo Vision, filtre de liens et filtre QR activés.');
      return;
    }

    if (step === 'sec_spam') {
      const { invalidateAutoModCache } = await import('../services/moderation/autoModService.js');
      await prisma.autoModConfig.upsert({
        where: { guildId },
        create: {
          guildId,
          spamEnabled: true,
          spamGroupSlowmodeEnabled: true,
          preventiveSlowmodeEnabled: true,
        },
        update: {
          spamEnabled: true,
          spamGroupSlowmodeEnabled: true,
          preventiveSlowmodeEnabled: true,
        },
      });
      invalidateAutoModCache(guildId);
      await sendSetupStep4(client, guildId, interaction, 'Anti-spam et mode lent préventif activés.');
      return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Action impossible (vérifie les permissions du bot).';
    await sendSetupStep4(client, guildId, interaction, `⚠️ ${msg}`);
  }
}

export async function sendSetupFinish(
  client: Client,
  guildId: string,
  target: TextChannel | BaseInteraction,
): Promise<void> {
  if (target instanceof BaseInteraction) {
    await acknowledgeInteraction(target);
  }
  const guild = await prisma.guild.findUnique({ where: { id: guildId } });

  const embed = new EmbedBuilder()
    .setColor(COLORS.success)
    .setTitle('✅ Configuration terminée !')
    .setDescription(
      "Votre bot Kotbo est maintenant prêt à l'emploi !\n\n" +
      "**Résumé de votre configuration :**\n" +
      `📡 **Salons :** Config : <#${guild?.configChannelId}> | Public : <#${guild?.publicChannelId}>\n` +
      `🛡️ **Rôle Mod :** ${guild?.moderatorRoleId ? `<@&${guild.moderatorRoleId}>` : 'Admin uniquement'}\n` +
      `🌐 **Traduction :** ${guild?.translationEnabled ? `Activé (${guild.defaultTranslateTo})` : 'Désactivée'}\n\n` +
      "*Vous pouvez modifier ces paramètres à tout moment via le tableau de bord.*"
    )
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('config:refresh')
      .setLabel('Ouvrir le Tableau de Bord')
      .setStyle(ButtonStyle.Primary)
  );

  await renderPanelTarget(target, { embeds: [embed], components: [row] });
}
