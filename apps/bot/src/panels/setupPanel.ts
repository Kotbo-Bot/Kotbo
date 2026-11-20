/**
 * `/setup` : la configuration de Kotbo depuis Discord.
 *
 * Le panneau lit le meme parcours que la page « Prise en main » du dashboard
 * (`computeSetupJourney`) : ce qui est en place et ce qui manque vient de la
 * configuration reelle, pas d'un compteur d'etapes franchies. Chaque point se
 * regle ici quand Discord le permet (salon, role, fuseau, bascule, outils de
 * securite) ; les autres renvoient a la bonne page du dashboard.
 *
 * Identifiants : `setup:home`, `setup:step:<cle>`, `setup:set:<cle>` (menus),
 * `setup:act:<action>` (boutons de reglage), `setup:sec:<outil>` (outils de
 * securite), `setup:open` (menu de l'accueil, la valeur porte la cle).
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  type BaseInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import prisma from '../utils/db.js';
import { COLORS } from '../utils/embeds.js';
import { acknowledgeInteraction, renderPanelTarget } from '../utils/interactionResponses.js';
import { publicErrorMessage } from '../utils/publicError.js';
import { resolveGuildLocale, type BotLocale } from '../utils/i18n.js';
import * as m from '../lib/paraglide/messages.js';
import { computeSetupJourney, type SetupStep } from '../services/core/setupJourney.js';
import { setDashboardModuleStatus } from '../services/core/moduleActivationService.js';
import { getRaidProtectionConfig, upsertRaidProtectionConfig } from '../services/moderation/raidProtectionService.js';
import { provisionJail } from '../services/moderation/jailService.js';
import { createShieldPanelChannel, postShieldPanel } from '../services/moderation/shieldService.js';
import { honeypotChannelName, provisionHoneypotChannel } from '../services/moderation/honeypotProvisioning.js';
import { dashboardUrl } from '../services/core/adminLifecycleService.js';

type Row = ActionRowBuilder<MessageActionRowComponentBuilder>;
type Msg = (params: Record<string, never>, options: { locale: BotLocale }) => string;

const STEP_EMOJI: Record<string, string> = {
  logs: '📜',
  'moderator-role': '🛡️',
  timezone: '🕒',
  regulation: '📘',
  security: '🔐',
  'sanction-alerts': '🚨',
  tickets: '🎫',
  'ticket-quotas': '🎟️',
  welcome: '👋',
};

/** Fuseaux proposes : Discord plafonne un menu a 25 options. */
const TIMEZONES = [
  'Europe/Paris', 'Europe/Brussels', 'Europe/Zurich', 'Europe/London', 'Europe/Lisbon',
  'Europe/Berlin', 'Europe/Madrid', 'Europe/Bucharest', 'Europe/Moscow',
  'Africa/Casablanca', 'Africa/Dakar', 'Africa/Abidjan', 'Indian/Reunion',
  'America/Martinique', 'America/Toronto', 'America/New_York', 'America/Chicago',
  'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo',
  'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Noumea', 'UTC',
];

/** Champ de `Guild` ecrit par chaque menu de selection. */
const GUILD_FIELD: Record<string, 'logChannelId' | 'moderatorRoleId' | 'sanctionAlertChannelId' | 'timezone'> = {
  logs: 'logChannelId',
  'moderator-role': 'moderatorRoleId',
  'sanction-alerts': 'sanctionAlertChannelId',
  timezone: 'timezone',
};

const SECURITY_TOOLS = ['jail', 'honeypot', 'shield', 'captcha', 'scam', 'spam'] as const;

function text(key: string, locale: BotLocale, params: Record<string, unknown> = {}): string {
  const fn = (m as unknown as Record<string, Msg>)[key];
  return fn ? fn(params as Record<string, never>, { locale }) : key;
}

function stepLabel(key: string, locale: BotLocale): string {
  return text(`setup_step_${key.replace(/-/g, '_')}_label`, locale);
}

function stepWhy(key: string, locale: BotLocale): string {
  return text(`setup_step_${key.replace(/-/g, '_')}_why`, locale);
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function progressBar(done: number, total: number): string {
  const filled = total === 0 ? 10 : Math.round((done / total) * 10);
  return `${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)}`;
}

function linkButton(label: string, url: string | null): ButtonBuilder | null {
  return url ? new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(url) : null;
}

function row(...components: (MessageActionRowComponentBuilder | null)[]): Row | null {
  const present = components.filter((c): c is MessageActionRowComponentBuilder => c !== null);
  return present.length > 0 ? new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(present) : null;
}

/** Points reglables : « Kotbo ajoute » est toujours fait et n'a rien a montrer. */
function actionableSteps(steps: SetupStep[]): SetupStep[] {
  return steps.filter((s) => s.key !== 'installed');
}

async function render(
  interaction: BaseInteraction,
  embed: EmbedBuilder,
  rows: (Row | null)[],
): Promise<void> {
  await renderPanelTarget(interaction, {
    embeds: [embed],
    components: rows.filter((r): r is Row => r !== null),
  });
}

async function renderUnknownGuild(interaction: BaseInteraction, locale: BotLocale): Promise<void> {
  await render(interaction, new EmbedBuilder().setColor(COLORS.warning).setDescription(m.setup_unknown_guild({}, { locale })), []);
}

// ─── Accueil ─────────────────────────────────────────────────────────────────

async function renderHome(interaction: BaseInteraction, guildId: string, locale: BotLocale): Promise<void> {
  const journey = await computeSetupJourney(guildId);
  if (!journey) return renderUnknownGuild(interaction, locale);

  const steps = actionableSteps(journey.steps);
  const done = steps.filter((s) => s.done).length;
  const groups = ['essentiel', 'moderation', 'engagement'] as const;

  const lines = [
    m.setup_home_intro({}, { locale }),
    '',
    `${progressBar(done, steps.length)}  **${done}/${steps.length}**`,
  ];
  for (const group of groups) {
    const inGroup = steps.filter((s) => s.group === group);
    if (inGroup.length === 0) continue;
    lines.push('', `**${text(`setup_group_${group}`, locale)}**`);
    for (const s of inGroup) lines.push(`${s.done ? '✅' : '⬜'} ${STEP_EMOJI[s.key] ?? ''} ${stepLabel(s.key, locale)}`);
  }
  if (done === steps.length) lines.push('', m.setup_home_all_done({}, { locale }));

  const embed = new EmbedBuilder()
    .setColor(done === steps.length ? COLORS.success : COLORS.primary)
    .setTitle(m.setup_home_title({}, { locale }))
    .setDescription(lines.join('\n'));

  const select = new StringSelectMenuBuilder()
    .setCustomId('setup:open')
    .setPlaceholder(m.setup_select_placeholder({}, { locale }))
    .addOptions(steps.map((s) => ({
      label: clip(stepLabel(s.key, locale), 100),
      description: clip(stepWhy(s.key, locale), 100),
      value: s.key,
      emoji: s.done ? '✅' : '⬜',
    })));

  const next = steps.find((s) => !s.done);
  await render(interaction, embed, [
    row(select),
    row(
      next
        ? new ButtonBuilder().setCustomId(`setup:step:${next.key}`).setLabel(m.setup_btn_next({}, { locale })).setStyle(ButtonStyle.Primary).setEmoji('➡️')
        : null,
      linkButton(m.setup_btn_guide({}, { locale }), dashboardUrl('/setup', guildId)),
    ),
  ]);
}

// ─── Un point du parcours ────────────────────────────────────────────────────

async function securityLines(client: Client, guildId: string, locale: BotLocale): Promise<string[]> {
  const discordGuild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
  const [guild, rprot, autoMod] = await Promise.all([
    prisma.guild.findUnique({ where: { id: guildId }, select: { honeypotEnabled: true, honeypotChannelId: true } }),
    getRaidProtectionConfig(guildId),
    prisma.autoModConfig.findUnique({ where: { guildId }, select: { spamEnabled: true } }),
  ]);

  const me = discordGuild?.members.me ?? null;
  const required: [bigint, string][] = [
    [PermissionFlagsBits.ManageRoles, 'setup_perm_manage_roles'],
    [PermissionFlagsBits.ManageChannels, 'setup_perm_manage_channels'],
    [PermissionFlagsBits.ManageMessages, 'setup_perm_manage_messages'],
    [PermissionFlagsBits.ModerateMembers, 'setup_perm_moderate'],
    [PermissionFlagsBits.KickMembers, 'setup_perm_kick'],
    [PermissionFlagsBits.BanMembers, 'setup_perm_ban'],
    [PermissionFlagsBits.ViewAuditLog, 'setup_perm_audit'],
  ];
  const missing = me ? required.filter(([bit]) => !me.permissions.has(bit)).map(([, key]) => text(key, locale)) : [];
  const off = m.setup_tool_off({}, { locale });
  const mark = (ok: boolean) => (ok ? '🟢' : '⚪');
  const honeypotOn = Boolean(guild?.honeypotEnabled && guild.honeypotChannelId);
  const captchaOn = Boolean(rprot?.captchaEnabled && rprot.captchaChannelId && rprot.captchaUnverifiedRoleId);
  const scamOn = (rprot?.visionEnabled ?? true) && Boolean(rprot?.scamFilterEnabled);

  return [
    `**${m.setup_diag_title({}, { locale })}**`,
    missing.length === 0
      ? m.setup_diag_ok({
        position: String(me?.roles.highest.position ?? 0),
        total: String(discordGuild ? discordGuild.roles.cache.size - 1 : 0),
      }, { locale })
      : m.setup_diag_missing({ perms: missing.join(', ') }, { locale }),
    '',
    `**${m.setup_tools_title({}, { locale })}**`,
    `${mark(Boolean(rprot?.jailRoleId))} ${m.setup_tool_jail({}, { locale })} : ${rprot?.jailRoleId ? `<@&${rprot.jailRoleId}>` : off}`,
    `${mark(honeypotOn)} ${m.setup_tool_honeypot({}, { locale })} : ${honeypotOn ? `<#${guild!.honeypotChannelId}>` : off}`,
    `${mark(Boolean(rprot?.shieldPanelChannelId))} ${m.setup_tool_shield({}, { locale })} : ${rprot?.shieldPanelChannelId ? `<#${rprot.shieldPanelChannelId}>` : off}`,
    `${mark(captchaOn)} ${m.setup_tool_captcha({}, { locale })} : ${captchaOn ? `<#${rprot!.captchaChannelId}>` : off}`,
    `${mark(scamOn)} ${m.setup_tool_scam({}, { locale })}${scamOn ? '' : ` : ${off}`}`,
    `${mark(Boolean(autoMod?.spamEnabled))} ${m.setup_tool_spam({}, { locale })}${autoMod?.spamEnabled ? '' : ` : ${off}`}`,
  ];
}

const SECURITY_BUTTONS: Record<(typeof SECURITY_TOOLS)[number], string> = {
  jail: '🔒',
  honeypot: '🍯',
  shield: '🛡️',
  captcha: '🔐',
  scam: '🔍',
  spam: '🐢',
};

function securityRows(locale: BotLocale): Row[] {
  const button = (tool: (typeof SECURITY_TOOLS)[number]) => new ButtonBuilder()
    .setCustomId(`setup:sec:${tool}`)
    .setLabel(text(`setup_tool_${tool}`, locale))
    .setEmoji(SECURITY_BUTTONS[tool])
    .setStyle(ButtonStyle.Secondary);
  return [
    row(button('jail'), button('honeypot'), button('shield'))!,
    row(button('captcha'), button('scam'), button('spam'))!,
  ];
}

async function renderStep(
  interaction: BaseInteraction,
  client: Client,
  guildId: string,
  locale: BotLocale,
  key: string,
  notice?: string,
): Promise<void> {
  const journey = await computeSetupJourney(guildId);
  if (!journey) return renderUnknownGuild(interaction, locale);

  const steps = actionableSteps(journey.steps);
  const step = steps.find((s) => s.key === key);
  if (!step) return renderHome(interaction, guildId, locale);

  const guild = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { logChannelId: true, moderatorRoleId: true, sanctionAlertChannelId: true, timezone: true, ticketQuotaOpenEnabled: true },
  });
  const welcome = key === 'welcome'
    ? await prisma.welcomeConfig.findUnique({ where: { guildId }, select: { welcomeChannelId: true } })
    : null;

  const current: Record<string, string | null | undefined> = {
    logs: guild?.logChannelId && `<#${guild.logChannelId}>`,
    'moderator-role': guild?.moderatorRoleId && `<@&${guild.moderatorRoleId}>`,
    'sanction-alerts': guild?.sanctionAlertChannelId && `<#${guild.sanctionAlertChannelId}>`,
    timezone: guild?.timezone,
    welcome: welcome?.welcomeChannelId && `<#${welcome.welcomeChannelId}>`,
  };

  const lines = [
    ...(notice ? [`> ${notice}`, ''] : []),
    stepWhy(key, locale),
    '',
    `${step.done ? m.setup_status_done({}, { locale }) : m.setup_status_todo({}, { locale })}${current[key] ? ` · ${current[key]}` : ''}`,
  ];
  if (!step.done && step.detail && key === 'tickets') lines.push(m.setup_status_missing({ detail: step.detail }, { locale }));

  const controls: (Row | null)[] = [];
  if (key === 'logs' || key === 'sanction-alerts' || key === 'welcome') {
    const select = new ChannelSelectMenuBuilder()
      .setCustomId(`setup:set:${key}`)
      .setPlaceholder(m.setup_pick_channel({}, { locale }))
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
    const id = key === 'welcome' ? welcome?.welcomeChannelId : key === 'logs' ? guild?.logChannelId : guild?.sanctionAlertChannelId;
    if (id) select.setDefaultChannels(id);
    controls.push(row(select));
  } else if (key === 'moderator-role') {
    const select = new RoleSelectMenuBuilder()
      .setCustomId('setup:set:moderator-role')
      .setPlaceholder(m.setup_pick_role({}, { locale }));
    if (guild?.moderatorRoleId) select.setDefaultRoles(guild.moderatorRoleId);
    controls.push(row(select));
  } else if (key === 'timezone') {
    const zones = guild?.timezone && !TIMEZONES.includes(guild.timezone) ? [guild.timezone, ...TIMEZONES] : TIMEZONES;
    controls.push(row(new StringSelectMenuBuilder()
      .setCustomId('setup:set:timezone')
      .setPlaceholder(m.setup_pick_timezone({}, { locale }))
      .addOptions(zones.slice(0, 25).map((zone) => ({ label: zone, value: zone, default: zone === guild?.timezone })))));
  } else if (key === 'ticket-quotas') {
    const on = guild?.ticketQuotaOpenEnabled === true;
    controls.push(row(new ButtonBuilder()
      .setCustomId('setup:act:ticket-quotas')
      .setLabel(on ? m.setup_quota_off({}, { locale }) : m.setup_quota_on({}, { locale }))
      .setStyle(on ? ButtonStyle.Secondary : ButtonStyle.Success)));
  } else if (key === 'security') {
    lines.push('', ...(await securityLines(client, guildId, locale)));
    if (!step.done) {
      controls.push(row(new ButtonBuilder()
        .setCustomId('setup:act:protection')
        .setLabel(m.setup_protection_enable({}, { locale }))
        .setStyle(ButtonStyle.Success)));
    }
    controls.push(...securityRows(locale));
  } else {
    lines.push('', m.setup_dashboard_only({}, { locale }));
  }

  // Point suivant : le prochain a faire apres celui-ci, en reprenant au debut.
  const index = steps.indexOf(step);
  const next = [...steps.slice(index + 1), ...steps.slice(0, index)].find((s) => !s.done);

  const embed = new EmbedBuilder()
    .setColor(step.done ? COLORS.success : COLORS.primary)
    .setTitle(`${STEP_EMOJI[key] ?? ''} ${stepLabel(key, locale)}`.trim())
    .setDescription(lines.join('\n'));

  await render(interaction, embed, [
    ...controls,
    row(
      new ButtonBuilder().setCustomId('setup:home').setLabel(m.setup_btn_back({}, { locale })).setStyle(ButtonStyle.Secondary).setEmoji('⬅️'),
      next
        ? new ButtonBuilder().setCustomId(`setup:step:${next.key}`).setLabel(m.setup_btn_next({}, { locale })).setStyle(ButtonStyle.Primary).setEmoji('➡️')
        : null,
      linkButton(m.setup_btn_dashboard({}, { locale }), dashboardUrl(step.href, guildId)),
    ),
  ]);
}

// ─── Ecritures ───────────────────────────────────────────────────────────────

async function applySelection(guildId: string, key: string, value: string, locale: BotLocale): Promise<string> {
  if (key === 'welcome') {
    await prisma.welcomeConfig.upsert({
      where: { guildId },
      create: { guildId, welcomeEnabled: true, welcomeChannelId: value },
      update: { welcomeEnabled: true, welcomeChannelId: value },
    });
    // L'etape n'est faite qu'avec le module allume : un salon choisi sur un
    // module eteint laisserait le point « a regler » sans raison visible.
    await setDashboardModuleStatus(guildId, 'welcome_goodbye', true);
    return m.setup_saved({}, { locale });
  }

  const field = GUILD_FIELD[key];
  if (!field) return m.setup_action_failed({}, { locale });
  if (field === 'timezone' && !TIMEZONES.includes(value)) {
    const existing = await prisma.guild.findUnique({ where: { id: guildId }, select: { timezone: true } });
    if (existing?.timezone !== value) return m.setup_action_failed({}, { locale });
  }
  await prisma.guild.update({ where: { id: guildId }, data: { [field]: value } });
  return m.setup_saved({}, { locale });
}

async function applyAction(guildId: string, action: string, locale: BotLocale): Promise<{ step: string; notice: string }> {
  if (action === 'ticket-quotas') {
    const current = await prisma.guild.findUnique({ where: { id: guildId }, select: { ticketQuotaOpenEnabled: true } });
    await prisma.guild.update({ where: { id: guildId }, data: { ticketQuotaOpenEnabled: !current?.ticketQuotaOpenEnabled } });
    return { step: 'ticket-quotas', notice: m.setup_saved({}, { locale }) };
  }
  if (action === 'protection') {
    await setDashboardModuleStatus(guildId, 'automod', true);
    await setDashboardModuleStatus(guildId, 'raid_protection', true);
    return { step: 'security', notice: m.setup_protection_enabled({}, { locale }) };
  }
  return { step: 'security', notice: m.setup_action_failed({}, { locale }) };
}

async function applySecurityTool(guild: Guild, tool: string, locale: BotLocale, reason: string): Promise<string> {
  const guildId = guild.id;

  if (tool === 'jail') {
    const res = await provisionJail(guild, { createChannel: true });
    return m.setup_sec_jail_done({ role: `<@&${res.roleId}>`, count: String(res.channelsUpdated) }, { locale });
  }

  if (tool === 'honeypot') {
    const existing = await prisma.guild.findUnique({ where: { id: guildId }, select: { honeypotChannelId: true } });
    let channelId = existing?.honeypotChannelId ?? null;
    if (!channelId || !guild.channels.cache.has(channelId)) {
      const channel = await provisionHoneypotChannel(guild, { name: honeypotChannelName(locale), reason });
      channelId = channel.id;
    }
    await prisma.guild.update({ where: { id: guildId }, data: { honeypotEnabled: true, honeypotChannelId: channelId } });
    return m.setup_sec_honeypot_done({ channel: `<#${channelId}>` }, { locale });
  }

  if (tool === 'shield') {
    const rprot = await getRaidProtectionConfig(guildId);
    const channelId = rprot?.shieldPanelChannelId && guild.channels.cache.has(rprot.shieldPanelChannelId)
      ? rprot.shieldPanelChannelId
      : await createShieldPanelChannel(guild);
    await postShieldPanel(guild, channelId);
    return m.setup_sec_shield_done({ channel: `<#${channelId}>` }, { locale });
  }

  if (tool === 'captcha') {
    const rprot = await getRaidProtectionConfig(guildId);
    let roleId = rprot?.captchaUnverifiedRoleId && guild.roles.cache.has(rprot.captchaUnverifiedRoleId)
      ? rprot.captchaUnverifiedRoleId
      : null;
    if (!roleId) {
      const role = await guild.roles.create({ name: m.setup_captcha_role_name({}, { locale }), color: 0x95a5a6, permissions: [], reason });
      roleId = role.id;
    }
    let channelId = rprot?.captchaChannelId && guild.channels.cache.has(rprot.captchaChannelId) ? rprot.captchaChannelId : null;
    if (!channelId) {
      const channel = await guild.channels.create({
        name: m.setup_captcha_channel_name({}, { locale }),
        type: ChannelType.GuildText,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
          { id: guild.members.me!.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ManageMessages] },
        ],
        reason,
      });
      channelId = channel.id;
    }
    await upsertRaidProtectionConfig(guildId, {
      captchaEnabled: true,
      captchaChannelId: channelId,
      captchaUnverifiedRoleId: roleId,
      captchaTrigger: 'SMART',
      captchaUseServerIcon: true,
    });
    return m.setup_sec_captcha_done({ channel: `<#${channelId}>`, role: `<@&${roleId}>` }, { locale });
  }

  if (tool === 'scam') {
    await upsertRaidProtectionConfig(guildId, { visionEnabled: true, scamFilterEnabled: true, scamQrFilterEnabled: true });
    return m.setup_sec_scam_done({}, { locale });
  }

  if (tool === 'spam') {
    const { invalidateAutoModCache } = await import('../services/moderation/autoModService.js');
    const data = { spamEnabled: true, spamGroupSlowmodeEnabled: true, preventiveSlowmodeEnabled: true };
    await prisma.autoModConfig.upsert({ where: { guildId }, create: { guildId, ...data }, update: data });
    invalidateAutoModCache(guildId);
    return m.setup_sec_spam_done({}, { locale });
  }

  return m.setup_action_failed({}, { locale });
}

// ─── Points d'entree ─────────────────────────────────────────────────────────

export async function runSetupCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const locale = await resolveGuildLocale(guildId, interaction.guild?.preferredLocale);
  await acknowledgeInteraction(interaction);
  await renderHome(interaction, guildId, locale);
}

/** Tout composant `setup:*` : boutons et menus. */
export async function handleSetupInteraction(client: Client, guildId: string, interaction: BaseInteraction): Promise<void> {
  if (!interaction.isMessageComponent()) return;
  const locale = await resolveGuildLocale(guildId, interaction.guild?.preferredLocale);

  // La commande est reservee aux administrateurs par defaut, mais un serveur
  // peut l'ouvrir a d'autres : les ecritures se reverifient ici.
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: m.setup_denied({}, { locale }), flags: MessageFlags.Ephemeral });
    return;
  }

  // Les outils de securite creent salons et roles : plusieurs secondes,
  // au-dela du delai de reponse de Discord.
  await acknowledgeInteraction(interaction);

  const [, verb, arg = ''] = interaction.customId.split(':');
  try {
    if (verb === 'home') return await renderHome(interaction, guildId, locale);
    if (verb === 'step') return await renderStep(interaction, client, guildId, locale, arg);
    if (verb === 'open' && interaction.isStringSelectMenu()) {
      return await renderStep(interaction, client, guildId, locale, interaction.values[0] ?? '');
    }
    if (verb === 'set' && interaction.isAnySelectMenu()) {
      const value = interaction.values[0];
      const notice = value ? await applySelection(guildId, arg, value, locale) : undefined;
      return await renderStep(interaction, client, guildId, locale, arg, notice);
    }
    if (verb === 'act') {
      const { step, notice } = await applyAction(guildId, arg, locale);
      return await renderStep(interaction, client, guildId, locale, step, notice);
    }
    if (verb === 'sec') {
      const guild = interaction.guild ?? (await client.guilds.fetch(guildId).catch(() => null));
      if (!guild) return;
      const reason = m.setup_reason_setup({ user: interaction.user.username }, { locale });
      const notice = await applySecurityTool(guild, arg, locale, reason);
      return await renderStep(interaction, client, guildId, locale, 'security', `✨ ${notice}`);
    }
  } catch (err) {
    const notice = `⚠️ ${publicErrorMessage(err, m.setup_action_failed({}, { locale }), 'Setup')}`;
    const step = verb === 'sec' || verb === 'act' ? (arg === 'ticket-quotas' ? arg : 'security') : arg;
    await renderStep(interaction, client, guildId, locale, step, notice).catch(() => null);
  }
}
