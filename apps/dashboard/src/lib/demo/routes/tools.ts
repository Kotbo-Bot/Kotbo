/**
 * Outils du serveur : sauvegardes, planifications, clés MCP.
 *
 * Ces trois routes rendent un tableau nu côté bot (pas `{ backups: [...] }`) :
 * c'est pour cela que le repli générique de la démo laissait les pages vides
 * même après une création.
 */
import { route } from '../backend';
import { demoDb, demoId } from '../db';
import { row } from '../model';
import { G } from '../crud';
import { DAY, ME, ago, channelByName } from '../fixtures';
import { DEMO_GUILD_ID, DEMO_GUILD_NAME } from '../mode';

const backupSeed = () => [
  row('ServerBackup', {
    id: 'backup-1',
    name: 'Avant la refonte des salons',
    description: 'Sauvegarde complète avant de réorganiser les catégories.',
    createdByUserId: ME.id,
    createdByUsername: ME.username,
    serverName: DEMO_GUILD_NAME,
    sizeBytes: 182_400,
    rolesCount: 7,
    channelsCount: 15,
    membersCount: 128,
    emojisCount: 12,
    stickersCount: 3,
    createdAt: ago(3 * DAY),
    updatedAt: ago(3 * DAY),
  }),
  row('ServerBackup', {
    id: 'backup-2',
    name: 'Sauvegarde hebdomadaire',
    description: 'Créée par la planification du dimanche.',
    createdByUserId: ME.id,
    createdByUsername: 'Kotbo',
    serverName: DEMO_GUILD_NAME,
    sizeBytes: 176_900,
    rolesCount: 7,
    channelsCount: 14,
    membersCount: 121,
    emojisCount: 11,
    stickersCount: 3,
    createdAt: ago(10 * DAY),
    updatedAt: ago(10 * DAY),
  }),
];

const scheduleSeed = () => [
  {
    ...row('ScheduledTask'),
    id: 'schedule-1',
    name: 'Sauvegarde du dimanche',
    type: 'SERVER_BACKUP',
    cron: '0 4 * * 0',
    enabled: true,
    targetId: null,
    lastRun: ago(4 * DAY),
    message: null,
    messageEmbed: null,
    allowMentions: false,
    runOnce: false,
    createdAt: ago(40 * DAY),
    updatedAt: ago(4 * DAY),
  },
  {
    ...row('ScheduledTask'),
    id: 'schedule-2',
    name: 'Rappel de l’événement du vendredi',
    type: 'SEND_MESSAGE',
    cron: '0 18 * * 5',
    enabled: true,
    targetId: channelByName('annonces').id,
    lastRun: ago(1 * DAY),
    message: 'La soirée jeux commence dans une heure, rendez-vous dans le vocal Squad !',
    messageEmbed: null,
    allowMentions: false,
    runOnce: false,
    createdAt: ago(25 * DAY),
    updatedAt: ago(1 * DAY),
  },
  {
    ...row('ScheduledTask'),
    id: 'schedule-3',
    name: 'Vider #recherche-de-groupe',
    type: 'CHANNEL_RESET',
    cron: '0 5 * * 1',
    enabled: false,
    targetId: channelByName('recherche-de-groupe').id,
    lastRun: null,
    message: null,
    messageEmbed: null,
    allowMentions: false,
    runOnce: false,
    createdAt: ago(12 * DAY),
    updatedAt: ago(12 * DAY),
  },
];

const mcpSeed = () => [
  {
    id: 'mcp-key-1',
    name: 'Claude du staff',
    displayKey: 'ktb_mcp_••••••••3f9a',
    permissions: ['READ_STATS', 'READ_MEMBERS', 'READ_SANCTIONS'],
    isActive: true,
    lastUsedAt: ago(90),
    createdAt: ago(14 * DAY),
  },
];

const mcpLogs = () => [
  { id: 'mcp-log-1', ts: ago(90), level: 'info', guildId: DEMO_GUILD_ID, event: 'tools/call', method: 'POST', url: '/api/mcp', ua: 'Claude', data: { tool: 'get_guild_stats' } },
  { id: 'mcp-log-2', ts: ago(92), level: 'info', guildId: DEMO_GUILD_ID, event: 'tools/list', method: 'POST', url: '/api/mcp', ua: 'Claude', data: {} },
  { id: 'mcp-log-3', ts: ago(93), level: 'info', guildId: DEMO_GUILD_ID, event: 'initialize', method: 'POST', url: '/api/mcp', ua: 'Claude', data: {} },
];

/** Liste nue en mémoire, avec suppression par identifiant. */
function list<T extends { id: string }>(key: string, seed: () => T[]) {
  return {
    all: () => demoDb.get<T[]>(key, seed),
    save: (items: T[]) => demoDb.set(key, items),
  };
}

export function registerToolsRoutes(): void {
  const backups = list('backups', backupSeed);
  route('GET', `${G}/backups`, () => backups.all());
  route('POST', `${G}/backups`, ({ body }) => {
    const now = new Date().toISOString();
    const backup = row('ServerBackup', {
      ...backupSeed()[0],
      id: demoId(),
      name: body?.name || `Sauvegarde du ${new Date().toLocaleDateString('fr-FR')}`,
      description: body?.description || null,
      includeMessages: body?.includeMessages ?? false,
      includeMembers: body?.includeMembers ?? true,
      includeRoles: body?.includeRoles ?? true,
      includeChannels: body?.includeChannels ?? true,
      includeEmojis: body?.includeEmojis ?? true,
      includeStickers: body?.includeStickers ?? true,
      createdAt: now,
      updatedAt: now,
    });
    backups.save([backup, ...backups.all()]);
    return backup;
  });
  route('POST', `${G}/backups/import`, ({ body }) => {
    const now = new Date().toISOString();
    const backup = row('ServerBackup', { ...backupSeed()[0], id: demoId(), name: body?.name || 'Sauvegarde importée', createdAt: now, updatedAt: now });
    backups.save([backup, ...backups.all()]);
    return backup;
  });
  route('POST', `${G}/backups/:backupId/restore`, () => ({ success: true }));
  route('DELETE', `${G}/backups/:backupId`, ({ params }) => {
    backups.save(backups.all().filter((b) => b.id !== params.backupId));
    return { success: true };
  });
  route('GET', `${G}/backups/:backupId/export`, ({ params }) => {
    const backup = backups.all().find((b) => b.id === params.backupId);
    return new Response(JSON.stringify({ ...backup, data: { roles: [], channels: [] } }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${params.backupId}.json"` },
    });
  });

  const schedules = list('schedules', scheduleSeed);
  route('GET', `${G}/schedules`, () => schedules.all());
  route('POST', `${G}/schedules`, ({ body }) => {
    if (!body?.name || !body?.type || !body?.cron) {
      return new Response(JSON.stringify({ error: 'Champs obligatoires manquants (name, type, cron)' }), { status: 400 });
    }
    const now = new Date().toISOString();
    const schedule = {
      ...scheduleSeed()[0],
      id: demoId(),
      name: body.name,
      type: body.type,
      cron: body.cron,
      targetId: body.targetId || null,
      enabled: body.enabled ?? true,
      message: body.message ?? null,
      messageEmbed: body.messageEmbed ?? null,
      allowMentions: body.allowMentions === true,
      runOnce: body.runOnce === true,
      lastRun: null,
      createdAt: now,
      updatedAt: now,
    };
    schedules.save([schedule, ...schedules.all()]);
    return schedule;
  });
  route('PATCH', `${G}/schedules/:scheduleId`, ({ params, body }) => {
    let updated: unknown = null;
    schedules.save(
      schedules.all().map((s) => {
        if (s.id !== params.scheduleId) return s;
        const next = { ...s, ...(body ?? {}), updatedAt: new Date().toISOString() };
        updated = next;
        return next;
      }),
    );
    return updated;
  });
  route('DELETE', `${G}/schedules/:scheduleId`, ({ params }) => {
    schedules.save(schedules.all().filter((s) => s.id !== params.scheduleId));
    return { success: true };
  });
  route('POST', `${G}/schedules/:scheduleId/run`, ({ params }) => {
    schedules.save(schedules.all().map((s) => (s.id === params.scheduleId ? { ...s, lastRun: new Date().toISOString() } : s)));
    return { success: true };
  });

  const keys = list('mcp-keys', mcpSeed);
  route('GET', `${G}/mcp-keys`, () => keys.all().filter((k) => k.isActive));
  route('POST', `${G}/mcp-keys`, ({ body }) => {
    if (!body?.name?.trim()) return new Response(JSON.stringify({ error: 'Le champ "name" est requis.' }), { status: 400 });
    const suffix = Math.random().toString(16).slice(2, 6);
    const key = {
      id: demoId(),
      name: body.name.trim(),
      displayKey: `ktb_mcp_••••••••${suffix}`,
      permissions: body.permissions ?? ['READ_STATS', 'READ_MEMBERS', 'READ_SANCTIONS'],
      isActive: true,
      lastUsedAt: null,
      createdAt: new Date().toISOString(),
    };
    keys.save([key, ...keys.all()]);
    // Clé fictive : elle n'ouvre rien, la démo n'a pas de serveur MCP.
    return { ...key, fullKey: `ktb_mcp_demo_${Math.random().toString(36).slice(2)}${suffix}` };
  });
  route('DELETE', `${G}/mcp-keys/:keyId`, ({ params }) => {
    keys.save(keys.all().filter((k) => k.id !== params.keyId));
    return { ok: true };
  });
  route('GET', `${G}/mcp-keys/:keyId/direct-url`, () => ({
    directUrl: 'https://api.kotbo.fr/api/mcp-direct/demo/jeton-de-demonstration',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  }));
  route('GET', `${G}/mcp-logs`, () => ({ logs: mcpLogs() }));
}
