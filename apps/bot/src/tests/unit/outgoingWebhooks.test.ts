import { describe, expect, test } from 'bun:test';
import {
  OUTGOING_EVENTS,
  buildEnvelope,
  getOutgoingEvent,
  normalizeSubscribedEvents,
  subscribesTo,
} from '../../services/integrations/outgoingWebhookEvents.js';
import {
  WebhookUrlError,
  assertWebhookUrlReachable,
  assertWebhookUrlShape,
  generateWebhookSecret,
  isPrivateAddress,
  signWebhookPayload,
  verifyWebhookSignature,
} from '../../services/integrations/outgoingWebhookSecurity.js';

describe('catalogue des événements sortants', () => {
  test('chaque nom public est unique', () => {
    const types = OUTGOING_EVENTS.map((event) => event.type);
    expect(new Set(types).size).toBe(types.length);
  });

  test("n'expose aucun événement de message", () => {
    expect(OUTGOING_EVENTS.some((event) => event.source.startsWith('message:'))).toBe(false);
  });

  test("ignore l'arrivée d'un bot", () => {
    const joined = getOutgoingEvent('member.joined')!;
    expect(joined.map({ guildId: 'g', userId: 'u', userTag: 'bot', isBot: true, timestamp: 0 } as never)).toBeNull();
  });

  test('ignore une mise à jour de membre sans changement de rôle', () => {
    const roles = getOutgoingEvent('member.roles_updated')!;
    expect(roles.map({ guildId: 'g', userId: 'u', addedRoles: [], removedRoles: [], oldNickname: 'a', newNickname: 'b', isBoosting: false, timestamp: 0 } as never)).toBeNull();
  });

  test("ne transmet pas le texte capté par l'automod", () => {
    const automod = getOutgoingEvent('automod.triggered')!;
    const data = automod.map({ guildId: 'g', userId: 'u', channelId: 'c', rule: 'r', matchedContent: 'secret', action: 'DELETE', timestamp: 0 } as never);
    expect(JSON.stringify(data)).not.toContain('secret');
  });

  test('la durée du ticket se déduit de son ouverture', () => {
    const closed = getOutgoingEvent('ticket.closed')!;
    const data = closed.map({
      guildId: 'g', ticketId: 't', userId: 'u', userTag: 'x', closedById: 'm', claimedById: null,
      channelId: null, ticketTypeId: null, ticketTypeLabel: null, subject: 's', openedAt: 1_000, timestamp: 61_000,
    } as never);
    expect(data?.durationMs).toBe(60_000);
  });
});

describe('abonnements', () => {
  test('garde les noms connus, sans doublon, dans l’ordre du catalogue', () => {
    expect(normalizeSubscribedEvents(['ticket.closed', 'member.joined', 'inconnu', 'member.joined', 4])).toEqual(['member.joined', 'ticket.closed']);
  });

  test('« * » vaut tout le catalogue', () => {
    expect(normalizeSubscribedEvents(['member.joined', '*'])).toEqual(['*']);
    expect(subscribesTo(['*'], 'role.created')).toBe(true);
    expect(subscribesTo(['member.joined'], 'role.created')).toBe(false);
  });

  test("l'enveloppe porte l'identifiant, le type et la version", () => {
    const envelope = buildEnvelope('del_1', 'member.joined', 'g1', { userId: 'u' }, new Date('2026-10-04T00:00:00Z'));
    expect(envelope).toEqual({ id: 'del_1', type: 'member.joined', apiVersion: '2026-10-01', createdAt: '2026-10-04T00:00:00.000Z', guildId: 'g1', data: { userId: 'u' } });
  });
});

describe('URL des webhooks', () => {
  test('exige du HTTPS sur le port standard', () => {
    expect(() => assertWebhookUrlShape('http://example.com/hook')).toThrow(WebhookUrlError);
    expect(() => assertWebhookUrlShape('https://example.com:8443/hook')).toThrow(WebhookUrlError);
    expect(assertWebhookUrlShape(' https://example.com/hook ')).toBe('https://example.com/hook');
  });

  test('refuse les réseaux internes et les identifiants dans l’URL', () => {
    for (const url of ['https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.4/x', 'https://169.254.169.254/latest', 'https://[::1]/x', 'https://user:pass@example.com/x']) {
      expect(() => assertWebhookUrlShape(url)).toThrow(WebhookUrlError);
    }
  });

  test('refuse les webhooks Discord', () => {
    expect(() => assertWebhookUrlShape('https://discord.com/api/webhooks/1/abc')).toThrow(WebhookUrlError);
  });

  test('classe les adresses privées', () => {
    expect(isPrivateAddress('192.168.1.10')).toBe(true);
    expect(isPrivateAddress('172.20.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateAddress('fd00::1')).toBe(true);
    expect(isPrivateAddress('1.1.1.1')).toBe(false);
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
  });

  test('refuse un domaine qui se résout vers un réseau interne', async () => {
    const resolve = (async () => [{ address: '10.1.2.3', family: 4 }]) as never;
    await expect(assertWebhookUrlReachable('https://piege.example.com/x', resolve)).rejects.toThrow(WebhookUrlError);
  });

  test('accepte un domaine public', async () => {
    const resolve = (async () => [{ address: '93.184.216.34', family: 4 }]) as never;
    await expect(assertWebhookUrlReachable('https://example.com/x', resolve)).resolves.toBe('https://example.com/x');
  });
});

describe('signature', () => {
  test('une signature fraîche se vérifie', () => {
    const secret = generateWebhookSecret();
    const body = JSON.stringify({ hello: 'monde' });
    const header = signWebhookPayload(secret, body, 1_000);
    expect(header.startsWith('t=1000,v1=')).toBe(true);
    expect(verifyWebhookSignature(secret, body, header, 1_100)).toBe(true);
  });

  test('refuse un corps modifié, un autre secret ou un envoi trop ancien', () => {
    const secret = generateWebhookSecret();
    const header = signWebhookPayload(secret, '{"a":1}', 1_000);
    expect(verifyWebhookSignature(secret, '{"a":2}', header, 1_000)).toBe(false);
    expect(verifyWebhookSignature(generateWebhookSecret(), '{"a":1}', header, 1_000)).toBe(false);
    expect(verifyWebhookSignature(secret, '{"a":1}', header, 2_000)).toBe(false);
  });

  test('les secrets sont préfixés et distincts', () => {
    const a = generateWebhookSecret();
    expect(a.startsWith('whsec_')).toBe(true);
    expect(a).not.toBe(generateWebhookSecret());
  });
});
