/**
 * Catalogue des événements que les webhooks sortants peuvent recevoir.
 *
 * Les noms publics (« member.joined ») ne reprennent pas ceux du bus interne
 * (« member:join ») : le bus peut être réorganisé, un contrat promis à des
 * intégrations externes ne le peut pas. Chaque entrée dit donc à la fois d'où
 * vient l'événement et ce qu'on en expose.
 *
 * Ce qui n'est volontairement pas exposé :
 * - le contenu des messages (`message:*`) : volume énorme sur un serveur actif,
 *   et des membres qui n'ont jamais consenti à voir leurs messages quitter
 *   Discord vers un service tiers ;
 * - le texte capté par l'automod, pour la même raison ;
 * - la présence vocale, trop bavarde pour un webhook.
 */
import type { KotboEventMap, KotboEventName } from '@kotbo/core';

export type OutgoingEventCategory = 'members' | 'moderation' | 'tickets' | 'community' | 'server';

export interface OutgoingEventDefinition {
  /** Nom public, stable : c'est celui que les intégrations filtrent. */
  type: string;
  category: OutgoingEventCategory;
  description: string;
  source: KotboEventName;
  /**
   * Transforme le payload du bus en données publiées. Renvoyer `null` ignore
   * l'événement (une mise à jour de membre sans changement visible, par ex.).
   */
  map: (payload: never) => Record<string, unknown> | null;
  /** Exemple montré dans le dashboard et envoyé par le bouton « Tester ». */
  sample: Record<string, unknown>;
}

const iso = (timestamp: number) => new Date(timestamp).toISOString();

function define<E extends KotboEventName>(
  source: E,
  type: string,
  category: OutgoingEventCategory,
  description: string,
  map: (payload: KotboEventMap[E]) => Record<string, unknown> | null,
  sample: Record<string, unknown>,
): OutgoingEventDefinition {
  return { type, category, description, source, map: map as (payload: never) => Record<string, unknown> | null, sample };
}

const SAMPLE_USER = '123456789012345678';
const SAMPLE_MOD = '876543210987654321';

export const OUTGOING_EVENTS: OutgoingEventDefinition[] = [
  // ── Membres ─────────────────────────────────────────────
  define('member:join', 'member.joined', 'members', 'Un membre rejoint le serveur.',
    (p) => (p.isBot ? null : { userId: p.userId, userTag: p.userTag, joinedAt: iso(p.timestamp) }),
    { userId: SAMPLE_USER, userTag: 'alice', joinedAt: '2026-10-04T18:00:00.000Z' }),
  define('member:join:invite', 'member.joined_via_invite', 'members', "Arrivée dont l'invitation utilisée a été identifiée.",
    (p) => (p.isBot ? null : { userId: p.userId, userTag: p.userTag, inviteCode: p.inviteCode, inviterId: p.inviterId }),
    { userId: SAMPLE_USER, userTag: 'alice', inviteCode: 'kotbo', inviterId: SAMPLE_MOD }),
  define('member:leave', 'member.left', 'members', 'Un membre quitte le serveur (départ, exclusion ou bannissement).',
    (p) => (p.isBot ? null : { userId: p.userId, userTag: p.userTag, leftAt: iso(p.timestamp) }),
    { userId: SAMPLE_USER, userTag: 'alice', leftAt: '2026-10-04T18:00:00.000Z' }),
  define('member:update', 'member.roles_updated', 'members', 'Des rôles sont ajoutés ou retirés à un membre.',
    (p) => (p.addedRoles.length === 0 && p.removedRoles.length === 0
      ? null
      : { userId: p.userId, addedRoles: p.addedRoles, removedRoles: p.removedRoles }),
    { userId: SAMPLE_USER, addedRoles: ['111111111111111111'], removedRoles: [] }),
  define('level:up', 'member.level_up', 'members', 'Un membre passe un niveau.',
    (p) => ({ userId: p.userId, previousLevel: p.previousLevel, level: p.level }),
    { userId: SAMPLE_USER, previousLevel: 9, level: 10 }),

  // ── Modération ──────────────────────────────────────────
  define('sanction:applied', 'sanction.applied', 'moderation', 'Une sanction est appliquée (avertissement, exclusion, bannissement…).',
    (p) => ({
      sanctionId: p.sanctionId,
      type: p.type,
      targetId: p.targetId,
      targetTag: p.targetTag,
      moderatorId: p.moderatorId,
      moderatorTag: p.moderatorTag,
      reason: p.reason,
      durationMs: p.duration,
    }),
    { sanctionId: 'clx0sanction', type: 'TIMEOUT', targetId: SAMPLE_USER, targetTag: 'alice', moderatorId: SAMPLE_MOD, moderatorTag: 'modo', reason: 'Spam', durationMs: 600000 }),
  define('sanction:revoked', 'sanction.revoked', 'moderation', 'Une sanction est levée (débannissement, fin de mise en sourdine…).',
    (p) => ({ sanctionId: p.sanctionId, type: p.type, targetId: p.targetId, targetTag: p.targetTag ?? null, moderatorId: p.moderatorId }),
    { sanctionId: 'clx0sanction', type: 'UNBAN', targetId: SAMPLE_USER, targetTag: 'alice', moderatorId: SAMPLE_MOD }),
  define('automod:triggered', 'automod.triggered', 'moderation', "Une règle d'automodération s'est déclenchée. Le texte capté n'est pas transmis.",
    (p) => ({ userId: p.userId, channelId: p.channelId, rule: p.rule, action: p.action }),
    { userId: SAMPLE_USER, channelId: '222222222222222222', rule: 'invite_links', action: 'DELETE' }),

  // ── Tickets ─────────────────────────────────────────────
  define('ticket:created', 'ticket.created', 'tickets', 'Un ticket est ouvert.',
    (p) => ({ ticketId: p.ticketId, userId: p.userId, userTag: p.userTag, channelId: p.channelId, typeId: p.ticketTypeId, typeLabel: p.ticketTypeLabel, subject: p.subject }),
    { ticketId: 'clx0ticket', userId: SAMPLE_USER, userTag: 'alice', channelId: '333333333333333333', typeId: null, typeLabel: 'Support', subject: 'Je ne vois pas les salons' }),
  define('ticket:closed', 'ticket.closed', 'tickets', 'Un ticket est fermé.',
    (p) => ({
      ticketId: p.ticketId,
      userId: p.userId,
      userTag: p.userTag,
      closedById: p.closedById,
      claimedById: p.claimedById,
      typeLabel: p.ticketTypeLabel,
      subject: p.subject,
      openedAt: iso(p.openedAt),
      closedAt: iso(p.timestamp),
      durationMs: Math.max(0, p.timestamp - p.openedAt),
    }),
    { ticketId: 'clx0ticket', userId: SAMPLE_USER, userTag: 'alice', closedById: SAMPLE_MOD, claimedById: SAMPLE_MOD, typeLabel: 'Support', subject: 'Je ne vois pas les salons', openedAt: '2026-10-04T17:00:00.000Z', closedAt: '2026-10-04T18:00:00.000Z', durationMs: 3600000 }),
  define('ticket:rated', 'ticket.rated', 'tickets', 'Un membre note le support reçu sur un ticket.',
    (p) => ({ ticketId: p.ticketId, userId: p.userId, staffId: p.staffId, rating: p.rating, typeLabel: p.ticketTypeLabel }),
    { ticketId: 'clx0ticket', userId: SAMPLE_USER, staffId: SAMPLE_MOD, rating: 5, typeLabel: 'Support' }),

  // ── Communauté ──────────────────────────────────────────
  define('form:submitted', 'form.submitted', 'community', 'Une réponse est envoyée à un formulaire.',
    (p) => ({ formId: p.formId, formName: p.formName, submissionId: p.submissionId, userId: p.userId, authorName: p.authorName, answers: p.answers }),
    { formId: 'clx0form', formName: 'Candidature', submissionId: 'clx0sub', userId: SAMPLE_USER, authorName: 'alice', answers: [{ label: 'Âge', value: '19' }] }),
  define('suggestion:created', 'suggestion.created', 'community', 'Une suggestion est proposée.',
    (p) => ({ suggestionId: p.suggestionId, userId: p.userId, username: p.username, content: p.content, channelId: p.channelId, messageId: p.messageId }),
    { suggestionId: 'clx0sugg', userId: SAMPLE_USER, username: 'alice', content: 'Un salon musique', channelId: '444444444444444444', messageId: null }),
  define('suggestion:resolved', 'suggestion.resolved', 'community', 'Une suggestion est acceptée, refusée ou mise en place.',
    (p) => ({ suggestionId: p.suggestionId, userId: p.userId, status: p.status, response: p.responseText, respondedById: p.respondedById, upvotes: p.upvotes, downvotes: p.downvotes }),
    { suggestionId: 'clx0sugg', userId: SAMPLE_USER, status: 'APPROVED', response: 'Bonne idée !', respondedById: SAMPLE_MOD, upvotes: 12, downvotes: 1 }),
  define('giveaway:winner', 'giveaway.winner', 'community', 'Un membre gagne un concours.',
    (p) => ({ giveawayId: p.giveawayId, userId: p.userId, prize: p.prize, channelId: p.channelId }),
    { giveawayId: 'clx0give', userId: SAMPLE_USER, prize: 'Nitro', channelId: '555555555555555555' }),
  define('giveaway:ended', 'giveaway.ended', 'community', 'Un concours est clôturé.',
    (p) => ({ giveawayId: p.giveawayId, prize: p.prize, channelId: p.channelId, participantCount: p.participantCount, winnerCount: p.winnerCount }),
    { giveawayId: 'clx0give', prize: 'Nitro', channelId: '555555555555555555', participantCount: 340, winnerCount: 1 }),
  define('partnership:stage', 'partnership.stage_changed', 'community', "Un partenariat change d'étape.",
    (p) => ({ partnershipId: p.partnershipId, partnerId: p.partnerId, partnerName: p.partnerName, partnerGuildId: p.partnerGuildId, from: p.fromStage, to: p.toStage, reason: p.reason }),
    { partnershipId: 'clx0part', partnerId: 'clx0partner', partnerName: 'Serveur ami', partnerGuildId: null, from: 'NEGOTIATION', to: 'ACTIVE', reason: null }),

  // ── Structure du serveur ────────────────────────────────
  define('channel:create', 'channel.created', 'server', 'Un salon est créé.',
    (p) => ({ channelId: p.channelId, name: p.channelName, type: p.channelType }),
    { channelId: '666666666666666666', name: 'annonces', type: 0 }),
  define('channel:delete', 'channel.deleted', 'server', 'Un salon est supprimé.',
    (p) => ({ channelId: p.channelId, name: p.channelName, type: p.channelType }),
    { channelId: '666666666666666666', name: 'annonces', type: 0 }),
  define('role:create', 'role.created', 'server', 'Un rôle est créé.',
    (p) => ({ roleId: p.roleId, name: p.roleName }),
    { roleId: '777777777777777777', name: 'Membre' }),
  define('role:delete', 'role.deleted', 'server', 'Un rôle est supprimé.',
    (p) => ({ roleId: p.roleId, name: p.roleName }),
    { roleId: '777777777777777777', name: 'Membre' }),
];

/** Événement envoyé par le bouton « Tester » : jamais publié par le serveur. */
export const PING_EVENT = 'webhook.ping';

const BY_TYPE = new Map(OUTGOING_EVENTS.map((event) => [event.type, event]));

export function getOutgoingEvent(type: string): OutgoingEventDefinition | undefined {
  return BY_TYPE.get(type);
}

export function isKnownOutgoingEvent(type: string): boolean {
  return BY_TYPE.has(type);
}

/**
 * Normalise une liste d'abonnements reçue du dashboard : noms connus, sans
 * doublon, dans l'ordre du catalogue. `*` vaut « tout le catalogue », y compris
 * ce qui y sera ajouté plus tard, comme le propose Stripe.
 */
export function normalizeSubscribedEvents(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const wanted = new Set(input.filter((value): value is string => typeof value === 'string'));
  if (wanted.has('*')) return ['*'];
  return OUTGOING_EVENTS.map((event) => event.type).filter((type) => wanted.has(type));
}

export function subscribesTo(events: readonly string[], type: string): boolean {
  return events.includes('*') || events.includes(type);
}

/** Version du format d'enveloppe, envoyée en en-tête et dans le corps. */
export const OUTGOING_WEBHOOK_API_VERSION = '2026-10-01';

export interface OutgoingEnvelope {
  id: string;
  type: string;
  apiVersion: string;
  createdAt: string;
  guildId: string;
  data: Record<string, unknown>;
}

export function buildEnvelope(id: string, type: string, guildId: string, data: Record<string, unknown>, createdAt = new Date()): OutgoingEnvelope {
  return { id, type, apiVersion: OUTGOING_WEBHOOK_API_VERSION, createdAt: createdAt.toISOString(), guildId, data };
}
