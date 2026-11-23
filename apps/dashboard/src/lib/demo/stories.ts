/**
 * Ce qui s'est passé sur le serveur de démo : sanctions et journal.
 *
 * Les mêmes faits se retrouvent sur plusieurs pages, comme sur un vrai
 * serveur : la sanction de Vantar est dans la liste des sanctions, sur sa fiche
 * et dans le journal d'audit.
 */
import type { AuditEntry, SanctionItem } from '@kotbo/contracts';
import { ago, DAY, HOUR, personByName, ME } from './fixtures';

const tag = (name: string) => personByName(name).username;

function sanction(
  n: number,
  type: SanctionItem['type'],
  target: string,
  moderator: string,
  reason: string,
  minutesAgo: number,
  extra: Partial<SanctionItem> = {},
): SanctionItem {
  return {
    id: `900000000000000${String(500 + n)}`,
    type,
    status: 'ACTIVE',
    targetUserId: personByName(target).id,
    targetTag: tag(target),
    moderatorUserId: moderator === 'Toi' ? ME.id : personByName(moderator).id,
    moderatorTag: moderator === 'Toi' ? ME.username : tag(moderator),
    reason,
    durationSeconds: null,
    expiresAt: null,
    createdAt: ago(minutesAgo),
    resolvedAt: null,
    resolutionNote: null,
    archivedAt: null,
    archiveReason: null,
    appealable: true,
    appealLockReason: null,
    weight: 1,
    ...extra,
  };
}

export function sanctionsSeed(): SanctionItem[] {
  return [
    sanction(1, 'WARN', 'Vantar', 'Toi', 'Spam de liens en #général', 2 * HOUR),
    sanction(2, 'TIMEOUT', 'Vantar', 'Lena', 'Insultes en vocal', 2 * DAY, {
      durationSeconds: 3600,
      expiresAt: ago(2 * DAY - 60),
      status: 'RESOLVED',
      resolvedAt: ago(2 * DAY - 60),
      resolutionNote: 'Durée écoulée',
    }),
    sanction(3, 'WARN', 'Kyzo', 'Toi', 'Provocations répétées', 5 * HOUR),
    sanction(4, 'WARN', 'Kyzo', 'Zenox', 'Pub pour un autre serveur en MP', 9 * DAY, {
      status: 'RESOLVED',
      resolvedAt: ago(2 * DAY),
      resolutionNote: 'Expiré après 7 jours',
    }),
    sanction(5, 'BAN', 'Sacha', 'Arka', 'Compte compromis, liens de phishing', 11 * DAY, {
      status: 'RESOLVED',
      resolvedAt: ago(10 * DAY),
      resolutionNote: 'Débanni après récupération du compte',
    }),
    sanction(6, 'TIMEOUT', 'Yanis', 'Toi', 'Flood dans #recherche-de-groupe', 4 * DAY, {
      durationSeconds: 600,
      expiresAt: ago(4 * DAY - 10),
      status: 'RESOLVED',
      resolvedAt: ago(4 * DAY - 10),
      resolutionNote: 'Durée écoulée',
    }),
  ];
}

function entry(n: number, user: string, action: string, module: string, details: string, minutesAgo: number, source: AuditEntry['source'] = 'discord'): AuditEntry {
  return {
    id: `audit-${n}`,
    user,
    action,
    context: 'Atelier Nova',
    module,
    eventType: source === 'dashboard' ? 'Manuel' : 'Automatique',
    source,
    details,
    dateIso: ago(minutesAgo),
    channelId: null,
  };
}

export function auditSeed(): AuditEntry[] {
  return [
    entry(1, 'Zenox', 'Avertissement', 'Sanctions', 'Vantar averti : spam de liens en #général', 2 * HOUR),
    entry(2, 'Kotbo', 'Message supprimé', 'Auto-Modération', 'Lien suspect supprimé dans #général', 2 * HOUR + 2),
    entry(3, 'Aiden', 'Avertissement', 'Sanctions', 'Kyzo averti : provocations répétées', 5 * HOUR),
    entry(4, 'Lena', 'Ticket pris en charge', 'Tickets', 'Ticket #0147 pris en charge', 6 * HOUR),
    entry(5, 'Kotbo', 'Nouveau membre', 'Accueil', 'Tom a rejoint le serveur', 3 * HOUR),
    entry(6, 'Arka', 'Module activé', 'Modules', 'Économie activée', 3 * DAY, 'dashboard'),
    entry(7, 'Lena', 'Configuration', 'Niveaux', 'Rôle Habitué attribué au niveau 25', 4 * DAY, 'dashboard'),
    entry(8, 'Kotbo', 'Raid bloqué', 'Anti-raid', '6 comptes créés le jour même refusés en 2 minutes', 6 * DAY),
  ];
}
