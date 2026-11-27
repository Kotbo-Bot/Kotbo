/**
 * Garde des rôles de la cellule de suivi.
 *
 * La cellule et la direction peuvent se composer par rôles Discord, et un rôle
 * se donne hors de Kotbo : quiconque a « Gérer les rôles » pouvait s'ajouter à
 * la cellule et lire les dossiers, sans que personne ne le sache. Le journal
 * d'audit de Discord voit chaque changement, quel qu'en soit l'auteur, Kotbo
 * compris : c'est là qu'on écoute.
 *
 * - Un ajout par quelqu'un d'autre que le propriétaire est annulé.
 * - Tout changement est inscrit à l'audit et signalé (événement MEMBERSHIP_CHANGE).
 *
 * Il faut au bot les permissions « Voir les logs du serveur » et « Gérer les
 * rôles », avec un rôle placé au-dessus de ceux de la cellule.
 */
import { AuditLogEvent, Events, type Client } from 'discord.js';
import prisma from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { pushAudit } from '../api/shared.js';
import { sendWellbeingAlert } from '../services/staff/wellbeingAlerts.js';
import {
  WELLBEING_AUDIT_MODULE,
  cellMembershipChanges,
  roleDeltaFromChanges,
  shouldRevertCellRoleGrant,
} from '../services/staff/wellbeingPolicy.js';

const REVERT_TTL_MS = 60_000;
/** Retraits faits par la garde elle-même : leur propre entrée d'audit n'est pas re-signalée. */
const ownReverts = new Map<string, number>();

function markOwnRevert(key: string): void {
  const now = Date.now();
  ownReverts.set(key, now);
  for (const [k, at] of ownReverts) if (now - at > REVERT_TTL_MS) ownReverts.delete(k);
}

function consumeOwnRevert(key: string): boolean {
  const at = ownReverts.get(key);
  ownReverts.delete(key);
  return at !== undefined && Date.now() - at <= REVERT_TTL_MS;
}

export function registerWellbeingRoleWatch(client: Client): void {
  client.on(Events.GuildAuditLogEntryCreate, async (entry, guild) => {
    if (entry.action !== AuditLogEvent.MemberRoleUpdate) return;
    const targetId = typeof entry.targetId === 'string' ? entry.targetId : null;
    if (!targetId) return;

    try {
      const delta = roleDeltaFromChanges(entry.changes as ReadonlyArray<{ key: string; new?: unknown }>);
      if (delta.added.length === 0 && delta.removed.length === 0) return;
      const config = await prisma.wellbeingConfig.findUnique({ where: { guildId: guild.id } });
      const changes = cellMembershipChanges(config, delta);
      if (changes.length === 0) return;

      const executorId = entry.executorId ?? null;
      const executorName = entry.executor?.username ?? executorId ?? 'Auteur inconnu';

      for (const change of changes) {
        const key = `${guild.id}:${targetId}:${change.roleId}`;
        if (change.change === 'removed' && executorId === client.user?.id && consumeOwnRevert(key)) continue;

        // « Annulé » seulement si le retrait a réussi : un rôle du bot placé trop
        // bas le fait échouer, et l'alerte ne doit pas rassurer à tort.
        let reverted = false;
        if (change.change === 'added' && shouldRevertCellRoleGrant(executorId, guild.ownerId)) {
          markOwnRevert(key);
          const member = await guild.members.fetch(targetId).catch(() => null);
          reverted = !!member && await member.roles
            .remove(change.roleId, '[Cellule de suivi] Seul le propriétaire du serveur peut donner ce rôle')
            .then(() => true, (err) => {
              logger.error('Wellbeing', `Rôle ${change.roleId} non retiré à ${targetId} :`, err);
              return false;
            });
        }

        const group = change.scope === 'direction' ? 'direction' : 'cellule';
        await pushAudit(guild.id, {
          user: executorName,
          action: 'Appartenance Cellule de suivi',
          context: guild.name,
          module: WELLBEING_AUDIT_MODULE,
          eventType: 'Sécurité',
          details: change.change === 'added'
            ? `Rôle de ${group} donné à ${targetId}${reverted ? ' — annulé : seul le propriétaire peut le donner' : ''}.`
            : `Rôle de ${group} retiré à ${targetId}.`,
          channelId: null,
        });
        void sendWellbeingAlert(client, guild.id, config, 'MEMBERSHIP_CHANGE', {
          actorId: executorId ?? '',
          targetId,
          change: change.change,
          scope: change.scope,
          reverted,
        });
      }
    } catch (err) {
      logger.error('Wellbeing', 'Garde des rôles de la cellule en échec :', err);
    }
  });
}
