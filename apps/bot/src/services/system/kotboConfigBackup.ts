import { Prisma } from '@prisma/client';
import prisma from '../../utils/db.js';

// Tables de configuration à une ligne par serveur, clé `guildId`.
export const KOTBO_SINGLETON_MODELS = [
  'AegisConfig', 'BanAppealConfig', 'AuditLoggerConfig', 'AutoModConfig', 'ChannelHealthConfig',
  'GiveawayConfig', 'DashboardSettings', 'EconomyConfig', 'GhostAnalyzerConfig', 'WelcomeConfig',
  'WelcomeThreadConfig', 'LevelConfig', 'PartnershipSettings', 'PartnershipDirectoryListing',
  'CallPermissionConfig', 'RaidProtectionConfig', 'RankedConfig', 'ShopSettings', 'SimulationConfig',
  'CommunitySite', 'SpamDetectionConfig', 'StarboardConfig', 'TempVoiceAccessRequestConfig',
  'TempVoiceModPermissionsConfig', 'RpgTowerConfig', 'RpgClanTowerConfig', 'TutoringConfig',
] as const;

// Tables de configuration à plusieurs lignes, clé `id`. Les parents avant leurs enfants.
// Exclus volontairement : statistiques, journaux, activité des membres, et les tables
// qui portent un secret (CustomBotConfig, OutgoingWebhook, McpApiKey, APIKey), car un
// export part dans un fichier JSON.
export const KOTBO_LIST_MODELS = [
  'StaffHierarchy', 'StaffRole', 'StaffMember', 'StaffListPanel', 'StaffProcedure',
  'DoingList', 'DoingListColumn',
  'AnalyticsAlertRule', 'AnalyticsReportSchedule', 'AnalyticsSavedView', 'AnalyticsAnnotation',
  'BanAppealBlacklist', 'AutoThreadConfig', 'ThreadPanel', 'ScheduledTask', 'AutoResponse', 'BannedWord',
  'CodePoliceRule', 'SanctionTable', 'GuildLogEventConfig', 'GuildRegulationArticle',
  'GiveawayConfigPreset', 'GiveawayTemplate', 'ReactionRoleMenu', 'StickyMessage',
  'NewsCategoryConfig', 'YoutubeChannelFollow', 'TwitchChannelFollow', 'GithubRepoFollow', 'HuggingFaceFollow', 'Feed',
  'DashboardFeatureConfig', 'DashboardFeatureRoleAccess', 'DashboardRoleAccess', 'NotificationTarget', 'DashboardLayoutPreset',
  'WelcomeThreadStep', 'WelcomeMenuPage', 'WelcomeExperiment',
  'LevelRoleReward', 'AutoLeaderboard', 'QuestDefinition', 'RankedTierRole', 'DropConfig',
  'RecruitmentForm', 'RecruitmentPanel', 'CustomForm', 'TicketMacro',
  'ShopOffer', 'ShopPromoCode', 'SimulationScenario', 'TutoringItem', 'Workflow', 'WidgetSubscription',
  'RpgItem', 'RpgRecipe', 'RpgMonster', 'RpgTitle', 'RpgQuest', 'RpgRaidBoss', 'RpgFish',
  'RpgFishBookReward', 'RpgDungeon', 'RpgAdventureEvent', 'RpgTowerReward',
  'SitePage', 'SiteForumCategory', 'SiteVoteSite',
] as const;

// Champs de la ligne Guild qui relèvent de l'abonnement, de l'activation ou d'un état
// interne : ils ne doivent jamais revenir en arrière avec une sauvegarde.
const GUILD_EXCLUDED_FIELD = /^(id|instanceId|activat.*|access.*|plan|stripe.*|billing.*|renewalNoticeSentFor|lifecycleRemindersSent|lastLifecycleReminderAt|onboarding.*|createdAt|updatedAt|messageLoggingStatus|.*BackfillStatus)$/;

type Row = Record<string, unknown>;

export interface KotboConfigData {
  guild: Row | null;
  singletons: Record<string, Row>;
  lists: Record<string, Row[]>;
}

const modelFields = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m.fields]));

function delegate(model: string) {
  return (prisma as unknown as Record<string, {
    findUnique: (args: unknown) => Promise<Row | null>;
    findMany: (args: unknown) => Promise<Row[]>;
    upsert: (args: unknown) => Promise<unknown>;
    update: (args: unknown) => Promise<unknown>;
  }>)[model.charAt(0).toLowerCase() + model.slice(1)];
}

// Bytes en base64 à l'export, pour que le JSON reste lisible et rechargeable.
function serializeRow(model: string, row: Row): Row {
  for (const field of modelFields.get(model) ?? []) {
    if (field.type === 'Bytes' && row[field.name] instanceof Uint8Array) {
      row[field.name] = Buffer.from(row[field.name] as Uint8Array).toString('base64');
    }
  }
  return row;
}

// Prisma refuse `null` brut sur un champ Json et attend des Bytes, pas du base64.
function deserializeRow(model: string, row: Row): Row {
  const out = { ...row };
  for (const field of modelFields.get(model) ?? []) {
    if (field.kind !== 'scalar' || !(field.name in out)) continue;
    if (field.type === 'Json' && out[field.name] === null) out[field.name] = Prisma.DbNull;
    if (field.type === 'Bytes' && typeof out[field.name] === 'string') {
      out[field.name] = new Uint8Array(Buffer.from(out[field.name] as string, 'base64'));
    }
  }
  return out;
}

export async function exportKotboConfig(guildId: string): Promise<KotboConfigData> {
  const guildRow = await prisma.guild.findUnique({ where: { id: guildId } }) as Row | null;
  const guild = guildRow
    ? Object.fromEntries(Object.entries(guildRow).filter(([key]) => !GUILD_EXCLUDED_FIELD.test(key)))
    : null;

  const singletons: Record<string, Row> = {};
  for (const model of KOTBO_SINGLETON_MODELS) {
    const row = await delegate(model).findUnique({ where: { guildId } });
    if (row) singletons[model] = serializeRow(model, row);
  }

  const lists: Record<string, Row[]> = {};
  for (const model of KOTBO_LIST_MODELS) {
    const rows = await delegate(model).findMany({ where: { guildId } });
    if (rows.length > 0) lists[model] = rows.map((row) => serializeRow(model, row));
  }

  return { guild, singletons, lists };
}

export function countKotboConfigRows(data: KotboConfigData | undefined): number {
  if (!data) return 0;
  return Object.keys(data.singletons).length
    + Object.values(data.lists).reduce((sum, rows) => sum + rows.length, 0);
}

/**
 * Remet la configuration Kotbo du serveur dans l'état de la sauvegarde. Les lignes
 * créées depuis restent en place (comme pour les rôles et salons). Les identifiants
 * de rôles et salons recréés par la restauration Discord sont remplacés partout.
 * À n'appeler que sur une sauvegarde créée par le bot pour ce même serveur : une
 * sauvegarde importée ne porte jamais de configuration (voir backupImportValidation).
 */
export async function restoreKotboConfig(
  guildId: string,
  data: KotboConfigData,
  idMap: Map<string, string>,
): Promise<{ restored: number; failed: number }> {
  const remapped = JSON.parse(
    JSON.stringify(data).replace(/\d{17,20}/g, (id) => idMap.get(id) ?? id),
  ) as KotboConfigData;
  let restored = 0;
  let failed = 0;

  const attempt = async (label: string, run: () => Promise<unknown>) => {
    try {
      await run();
      restored++;
    } catch (error) {
      failed++;
      console.error(`[KotboConfigBackup] Restauration échouée pour ${label}:`, error);
    }
  };

  if (remapped.guild) {
    await attempt('Guild', () => prisma.guild.update({
      where: { id: guildId },
      data: deserializeRow('Guild', remapped.guild!) as Prisma.GuildUncheckedUpdateInput,
    }));
  }

  for (const model of KOTBO_SINGLETON_MODELS) {
    const row = remapped.singletons[model];
    if (!row) continue;
    const { id: _id, ...fields } = deserializeRow(model, row);
    const values = { ...fields, guildId };
    await attempt(model, () => delegate(model).upsert({ where: { guildId }, create: values, update: values }));
  }

  for (const model of KOTBO_LIST_MODELS) {
    for (const row of remapped.lists[model] ?? []) {
      const values = { ...deserializeRow(model, row), guildId };
      await attempt(`${model} ${String(row.id)}`, () => delegate(model).upsert({
        where: { id: row.id },
        create: values,
        update: values,
      }));
    }
  }

  return { restored, failed };
}
