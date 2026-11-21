/**
 * Boîte de notifications et Custom Bot. Formes de `notificationInbox.ts`
 * (liste paginée, lue / archivée) et de `customBot.ts` (serializeConfig).
 */
import { route } from '../backend';
import { demoDb } from '../db';
import { row } from '../model';
import { G } from '../crud';
import { DAY, HOUR, ago } from '../fixtures';
import { DEMO_GUILD_ID, DEMO_GUILD_NAME } from '../mode';

type Notif = {
  id: string; guildId: string; guildName: string; kind: string; category: string; title: string; message: string; type: string;
  link: string | null; actorId: string | null; count: number; data: null; isRead: boolean; archivedAt: string | null; createdAt: string; updatedAt: string;
};

function seed(): Notif[] {
  const n = (id: number, category: string, kind: string, type: string, title: string, message: string, link: string | null, minutes: number, extra: Partial<Notif> = {}): Notif => ({
    id: `notif-${id}`, guildId: DEMO_GUILD_ID, guildName: DEMO_GUILD_NAME, kind, category, title, message, type, link, actorId: null, count: 1, data: null,
    isRead: false, archivedAt: null, createdAt: ago(minutes), updatedAt: ago(minutes), ...extra,
  });
  return [
    n(1, 'recruitment', 'recruitment.new_candidature', 'INFO', 'Nouvelle candidature', 'Inès a candidaté pour devenir modératrice.', '/recruitment', 3 * 60),
    n(2, 'security', 'raid.suspicious_wave', 'WARNING', 'Vague d’arrivées suspecte', '9 comptes récents ont rejoint en 4 minutes avec le même tag.', '/security/anti-raid', 5 * 60, { count: 3 }),
    n(3, 'tickets', 'ticket.unanswered', 'WARNING', 'Ticket sans réponse', 'Le ticket n° 218 attend une réponse du staff depuis 26 h.', '/tickets', 8 * 60),
    n(4, 'moderation', 'appeal.new', 'INFO', 'Contestation de ban', 'Yanis conteste son bannissement.', '/security/sanctions/appeals', 20 * 60),
    n(5, 'staff', 'staff.absence_request', 'INFO', 'Demande d’absence', 'Kylian demande une absence du 24 au 30 novembre.', '/planning', DAY + 60),
    n(6, 'community', 'giveaway.ended', 'SUCCESS', 'Giveaway terminé', 'Le giveaway « Skin Valorant » est clôturé : Maëlle gagne.', '/giveaways', 2 * DAY, { isRead: true }),
    n(7, 'system', 'backup.created', 'SUCCESS', 'Sauvegarde créée', 'La sauvegarde hebdomadaire s’est terminée sans erreur.', '/backups', 3 * DAY, { isRead: true }),
    n(8, 'planning', 'meeting.reminder', 'INFO', 'Réunion staff demain', 'La réunion staff du vendredi commence à 20 h dans le vocal.', '/planning', 4 * DAY, { isRead: true }),
    n(9, 'security', 'security.audit_critical', 'ERROR', 'Point critique dans l’audit', '@everyone peut mentionner tout le monde dans 2 salons.', '/security', 6 * DAY, { archivedAt: ago(5 * DAY), isRead: true }),
  ];
}

const KEY = 'notifications';
const all = () => demoDb.get(KEY, seed);
const save = (list: Notif[]) => demoDb.set(KEY, list);

export function registerNotificationRoutes(): void {
  route('GET', '/api/dashboard/notifications', ({ query }) => {
    const status = query.get('status') ?? 'inbox';
    const category = query.get('category');
    const limit = Math.max(1, Number(query.get('limit')) || 30);
    const live = all().filter((x) => !x.archivedAt);
    const pool = all()
      .filter((x) => (status === 'archived' ? !!x.archivedAt : !x.archivedAt))
      .filter((x) => status !== 'unread' || !x.isRead)
      .filter((x) => !category || x.category === category)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const unread = live.filter((x) => !x.isRead).length;
    return { notifications: pool.slice(0, limit), nextCursor: null, unread, unreadByGuild: unread ? { [DEMO_GUILD_ID]: unread } : {} };
  });
  route('POST', '/api/dashboard/notifications/read-all', () => {
    const list = all();
    save(list.map((x) => ({ ...x, isRead: true })));
    return { updated: list.filter((x) => !x.isRead).length };
  });
  route('PATCH', '/api/dashboard/notifications/:id', ({ params, body }) => {
    save(all().map((x) => (x.id === params.id ? { ...x, ...(typeof body?.read === 'boolean' ? { isRead: body.read } : {}), ...(typeof body?.archived === 'boolean' ? { archivedAt: body.archived ? new Date().toISOString() : null } : {}) } : x)));
    return { ok: true };
  });
  route('DELETE', '/api/dashboard/notifications/:id', ({ params }) => {
    save(all().filter((x) => x.id !== params.id));
    return { ok: true };
  });

  // Custom Bot : un bot personnalisé déjà configuré, connecté et basculé.
  const botSeed = () => ({
    ...row('CustomBotConfig', {
      guildId: DEMO_GUILD_ID, enabled: true, botClientId: '1180000000000000099', botName: 'Nova', botBio: 'Le bot d’Atelier Nova : sanctions, niveaux et soirées jeux.',
      botStatus: 'ONLINE', activityType: 'PLAYING', activityText: 'avec la communauté', customDashboardUrl: 'dash.atelier-nova.fr', customDomainVerifiedAt: ago(20 * DAY), isRunning: true, lastStartedAt: ago(2 * HOUR),
    }),
    botToken: 'MTE4…••••3f9a',
    botClientSecret: '••••a1c2',
    secretsUnreadable: false,
    domain: { target: 'custom.kotbo.fr', verification: { type: 'TXT', name: '_kotbo-verify.dash.atelier-nova.fr', value: 'kotbo-site-verification=demo-7f3c9a' }, redirectUri: 'https://dash.atelier-nova.fr/api/auth/discord/callback', active: true },
  });
  const ownBot = () => ({ instanceId: 'instance-nova', switched: true, botInGuild: true, kotboInGuild: false, invitePermissions: '8', kotboClientId: '1100000000000000001' });
  route('GET', `${G}/custom-bot`, () => ({ allowed: true, config: demoDb.get('custom-bot', botSeed), ownBot: ownBot() }));
  route('PATCH', `${G}/custom-bot`, ({ body }) => ({ allowed: true, config: demoDb.update('custom-bot', botSeed, (c) => ({ ...c, ...(body ?? {}) })), profileErrors: [] }));
  route('POST', `${G}/custom-bot/validate`, () => ({ valid: true, bot: { id: '1180000000000000099', username: 'Nova' } }));
  route('POST', `${G}/custom-bot/domain/verify`, () => ({ verified: true, verifiedAt: new Date().toISOString() }));
  for (const action of ['start', 'stop', 'switch', 'revert']) route('POST', `${G}/custom-bot/${action}`, () => ({ ok: true, message: 'Action effectuée dans la démo.' }));
}
