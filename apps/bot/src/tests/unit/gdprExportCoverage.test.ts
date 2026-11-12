import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ACTOR_FIELDS } from '../../services/system/gdprProjections.js';

/**
 * Garde-fou de l'export RGPD, lu dans les sources (meme motif que les gardes
 * du dashboard). Trois familles de champs designent un membre :
 *
 *  - le sujet de la donnee (auteur, gagnant, acheteur...) : chaque champ doit
 *    etre interroge par une source de `gdprExportService.ts` ;
 *  - une liste de membres (`String[]`) : interrogee avec `has`, ou exclue avec
 *    sa raison ci-dessous ;
 *  - l'auteur d'une action (« cree par », « decide par ») : le champ doit
 *    figurer dans `ACTOR_FIELDS`, les traces sont generees depuis le schema.
 *
 * QUAND IL TOMBE : ajouter la source (avec une projection si la ligne contient
 * d'autres membres), le champ a `ACTOR_FIELDS`, ou l'exclusion motivee.
 */
const SUBJECT_FIELDS = [
  'userId', 'memberId', 'authorId', 'winnerId', 'discordId', 'discordUserId', 'targetUserId',
  'participantId', 'voterId', 'senderId', 'receiverId', 'inviterId', 'ownerId', 'ownerUserId',
  'creatorId', 'buyerId', 'sellerId', 'giverId', 'reporterId', 'requesterId', 'applicantUserId',
  'staffUserId', 'claimedBy', 'purchasedById', 'redeemedById', 'challengerId', 'opponentId',
  'ghostClaimedBy', 'altUserId', 'duplicateUserId', 'responsableUserId',
];

/** Listes de membres exportées : la source les interroge avec `has`. */
const MEMBER_LIST_FIELDS = [
  'participants', 'winners', 'pendingWinners', 'upvoters', 'downvoters', 'teamMemberIds',
  'kickedUserIds', 'reporterIds', 'progressionBlacklistUserIds',
];

/** Listes de membres volontairement hors de l'export, avec leur raison. */
const EXCLUDED_MEMBER_LISTS: Record<string, string> = {
  'MessageLog.mentionedUserIds': 'messages écrits par d\'autres : les exporter livrerait leur contenu',
  'AuditLoggerConfig.ignoredUserIds': 'réglage du serveur, sans information sur la personne',
  'AnalyticsAlertRule.notifyUserIds': 'réglage du serveur, sans information sur la personne',
  'AnalyticsReportSchedule.userIds': 'réglage du serveur, sans information sur la personne',
  'CallPermissionConfig.allowedUserIds': 'réglage du serveur, sans information sur la personne',
  'PanelThread.trustedIds': 'réglage du fil par son propriétaire, sans information sur la personne',
  'PanelThread.bannedIds': 'réglage du fil par son propriétaire, sans information sur la personne',
  'AutoModConfig.antiBotBypassUsers': 'réglage du serveur, sans information sur la personne',
};

/** Champs au nom d'auteur d'action qui n'en sont pas : état de jeu, réglage. */
const NOT_ACTOR_FIELDS = new Set([
  'killedBy', 'firstClearUserId', 'lastBumpUserId', 'countingLastUserId', 'oneWordStoryLastUserId',
  'wordChainLastUserId', 'chiefStaffUserId',
]);

const ACTOR_LIKE = /(By|ById|ByUserId|ByUsUserId|actorId|actorUserId|executorId|moderatorUserId|evaluatorId|mentorId|superiorUserId|authorUserId|LastUserId|UserId)$/;
const MEMBER_LIST_LIKE = /(user|member|participant|winner|voter|reporter|trusted|banned)/i;

const schemaDir = join(import.meta.dir, '../../../../../packages/database/prisma');
const service = readFileSync(join(import.meta.dir, '../../services/system/gdprExportService.ts'), 'utf8');

/** Clauses `where` de chaque modèle, telles qu'écrites dans les sources. */
const whereByModel = new Map<string, string[]>();
for (const [, model, where] of service.matchAll(/model: '(\w+)', where: (.*)$/gm)) {
  if (!model || !where) continue;
  whereByModel.set(model, [...(whereByModel.get(model) ?? []), where]);
}

interface SchemaField { model: string; accessor: string; name: string; isList: boolean }

function schemaStringFields(): SchemaField[] {
  const fields: SchemaField[] = [];
  for (const file of readdirSync(schemaDir).filter((name) => name.endsWith('.prisma'))) {
    const schema = readFileSync(join(schemaDir, file), 'utf8');
    for (const [, model, body] of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
      if (!model || !body) continue;
      const accessor = model.charAt(0).toLowerCase() + model.slice(1);
      for (const [, name, list] of body.matchAll(/^\s+(\w+)\s+String(\[\])?/gm)) {
        if (name) fields.push({ model, accessor, name, isList: list === '[]' });
      }
    }
  }
  return fields;
}

function queried(accessor: string, token: string): boolean {
  return (whereByModel.get(accessor) ?? []).some((where) => new RegExp(`\\b${token}\\b`).test(where));
}

const fields = schemaStringFields();

describe('export RGPD', () => {
  test('le schéma et les sources sont bien lus', () => {
    expect(fields.some((field) => field.model === 'MemberLevel' && field.name === 'userId')).toBe(true);
    expect(whereByModel.has('memberLevel')).toBe(true);
  });

  test('chaque champ qui désigne le sujet de la donnée est interrogé', () => {
    const missing = fields
      .filter((field) => !field.isList && SUBJECT_FIELDS.includes(field.name))
      // Une relation vers le participant d'un événement se filtre par la relation.
      .filter((field) => !queried(field.accessor, field.name === 'participantId' ? 'participant' : field.name))
      .map((field) => `${field.model}.${field.name}`);
    expect(missing).toEqual([]);
  });

  test('chaque liste de membres est exportée avec `has`, ou exclue avec sa raison', () => {
    const missing = fields
      // `bannedRoleIds`, `bannedChannelIds` : des rôles et des salons, pas des membres.
      .filter((field) => field.isList && MEMBER_LIST_LIKE.test(field.name) && !/(Role|Channel)Ids$/.test(field.name))
      .filter((field) => !(`${field.model}.${field.name}` in EXCLUDED_MEMBER_LISTS))
      .filter((field) => !(MEMBER_LIST_FIELDS.includes(field.name) && queried(field.accessor, `${field.name}: \\{ has`)))
      .map((field) => `${field.model}.${field.name}`);
    expect(missing).toEqual([]);
  });

  test('chaque champ d\'auteur d\'action est suivi par les traces', () => {
    const missing = fields
      .filter((field) => !field.isList && ACTOR_LIKE.test(field.name))
      .filter((field) => !SUBJECT_FIELDS.includes(field.name) && !NOT_ACTOR_FIELDS.has(field.name))
      .filter((field) => !ACTOR_FIELDS.includes(field.name))
      .map((field) => `${field.model}.${field.name}`);
    expect([...new Set(missing)]).toEqual([]);
  });

  test('un champ est soit sujet, soit auteur d\'action, jamais les deux', () => {
    expect(ACTOR_FIELDS.filter((field) => SUBJECT_FIELDS.includes(field))).toEqual([]);
  });
});
