import type { Client } from 'discord.js';
import { runWithCascadeDepth } from '@kotbo/core';
import { subscribeForModule } from '../services/core/moduleScope.js';
import { dispatchEvent } from '../services/features/workflow/workflowService.js';
import { isMessageEdit } from '../services/features/workflow/messageEdit.js';
import { isBotNicknameEcho } from '../services/features/workflow/nicknameEcho.js';
import { roleChangesToDispatch } from '../services/features/workflow/roleEcho.js';
import { logger } from '../utils/logger.js';

/**
 * Node Workflow Builder - pont entre le bus d'événements et le moteur.
 *
 * Module indépendant : s'il échoue, aucun autre module n'est affecté. Il ne
 * touche pas au système AutoResponse, qui continue de fonctionner en parallèle.
 */

const MODULE_NAME = 'workflow';

export function registerWorkflowBusSubscribers(client: Client): void {
  subscribeForModule('workflows', 'member:join', async (payload) => {
    if (payload.isBot) return;
    await dispatchEvent(client, payload.guildId, 'member:join', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'member:leave', async (payload) => {
    if (payload.isBot) return;
    await dispatchEvent(client, payload.guildId, 'member:leave', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'member:tag', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'member:tag', payload as never);
  }, MODULE_NAME);

  /**
   * Discord ne publie pas d'événement dédié aux rôles : `member:update`
   * transporte déjà les rôles gagnés et perdus, on en dérive donc deux
   * déclencheurs distincts plutôt que d'ajouter des publications au bus.
   *
   * Une exécution par rôle : plusieurs rôles donnés d'un coup (rôles-réactions,
   * onboarding Discord) arrivent dans une seule mise à jour, alors que le
   * déclencheur n'expose qu'un rôle. Une seule exécution laisserait les autres
   * hors de portée des conditions.
   */
  subscribeForModule('workflows', 'member:update', async (payload) => {
    // Les rôles posés par le bot reviennent par la passerelle, hors de la
    // profondeur de cascade : ils sont dépêchés à la profondeur de
    // l'automatisation qui les a posés, sinon « quand ce rôle est ajouté, le
    // retirer » et « quand il est retiré, l'ajouter » bouclent sans fin.
    const changes = roleChangesToDispatch(payload.guildId, payload.userId, payload.addedRoles, payload.removedRoles);
    for (const { roleId, kind, echoDepth } of changes) {
      const event = kind === 'added' ? 'member:role-added' : 'member:role-removed';
      const dispatch = () => dispatchEvent(client, payload.guildId, event, { ...payload, roleId } as never);
      await (echoDepth === undefined ? dispatch() : runWithCascadeDepth(echoDepth, dispatch));
    }
    if (
      payload.oldNickname !== payload.newNickname
      && !isBotNicknameEcho(payload.guildId, payload.userId, payload.newNickname)
    ) {
      await dispatchEvent(client, payload.guildId, 'member:nickname', payload as never);
    }
    if (payload.isBoosting) {
      await dispatchEvent(client, payload.guildId, 'member:boost', payload as never);
    }
  }, MODULE_NAME);

  subscribeForModule('workflows', 'member:join:invite', async (payload) => {
    if (payload.isBot) return;
    await dispatchEvent(client, payload.guildId, 'member:join:invite', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'message:update', async (payload) => {
    if (!isMessageEdit(payload)) return;
    await dispatchEvent(client, payload.guildId, 'message:update', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'message:new', async (payload) => {
    if (payload.isBot) return;
    await dispatchEvent(client, payload.guildId, 'message:new', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'reaction:add', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'reaction:add', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'reaction:remove', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'reaction:remove', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'voice:join', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'voice:join', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'voice:leave', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'voice:leave', payload as never);
  }, MODULE_NAME);

  // Le filtre de salons lit `channelId` : c'est le salon d'arrivée qui compte.
  subscribeForModule('workflows', 'voice:move', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'voice:move', { ...payload, channelId: payload.toChannelId } as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'thread:create', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'thread:create', payload as never);
  }, MODULE_NAME);

  // Partenariats : trois declencheurs. Le module « workflows » suffit a les
  // garder - si le module Partenariats est eteint, plus rien n'est publie.
  subscribeForModule('workflows', 'partnership:stage', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'partnership:stage', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'partnership:commitment-failed', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'partnership:commitment-failed', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'partnership:referral', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'partnership:referral', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'giveaway:entry', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'giveaway:entry', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'giveaway:winner', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'giveaway:winner', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'giveaway:ended', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'giveaway:ended', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'form:submitted', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'form:submitted', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'suggestion:created', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'suggestion:created', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'suggestion:resolved', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'suggestion:resolved', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'sanction:applied', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'sanction:applied', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'ticket:created', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'ticket:created', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'ticket:closed', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'ticket:closed', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'ticket:rated', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'ticket:rated', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'level:up', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'level:up', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'bet:resolved', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'bet:resolved', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'bet:refunded', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'bet:refunded', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'clan:debt-opened', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'clan:debt-opened', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'clan:debt-cleared', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'clan:debt-cleared', payload as never);
  }, MODULE_NAME);

  // Seules les victoires jouées dans un salon fun actif sont publiées : un
  // module Salons fun éteint ou un salon non configuré ne publie rien.
  subscribeForModule('workflows', 'fun:game-won', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'fun:game-won', payload as never);
  }, MODULE_NAME);

  // Messages supprimés : les suppressions en masse passent par un autre
  // événement Discord et n'arrivent pas ici. Les messages de bots sont écartés
  // plus loin, faute d'indication d'auteur fiable dans le payload.
  subscribeForModule('workflows', 'message:delete', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'message:delete', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'automod:triggered', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'automod:triggered', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'sanction:revoked', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'sanction:revoked', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'channel:create', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'channel:create', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'channel:delete', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'channel:delete', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'role:create', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'role:create', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'role:delete', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'role:delete', payload as never);
  }, MODULE_NAME);

  logger.info('Modules', `Module "${MODULE_NAME}" enregistré sur le bus d'events.`);
}
