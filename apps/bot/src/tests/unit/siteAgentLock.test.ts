/**
 * Verrou de l'agent sur le site : un agent qui écrit prend la main, un humain
 * peut l'interrompre, et l'agent interrompu ne peut plus écrire tant qu'on ne
 * l'y autorise pas de nouveau.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const auditRows: unknown[] = [];
mock.module('../../utils/db.js', () => {
  const prisma = { dashboardAuditLog: { create: async (args: unknown) => (auditRows.push(args), args) } };
  return { default: prisma, prisma, prismaRead: prisma };
});

const lock = await import('../../services/site/siteAgentLock.js');

const GUILD = '123456789012345678';

beforeEach(() => {
  lock.releaseAgentLock(GUILD);
  lock.allowAgentAgain(GUILD);
  auditRows.length = 0;
});

describe('verrou de l’agent', () => {
  test('une écriture de l’agent verrouille le site', () => {
    expect(lock.isSiteAgentLocked(GUILD)).toBe(false);
    lock.beginAgentWrite(GUILD, 'Claude', 'Rédaction du wiki', 'clx1234567890abcdefghijk');
    const status = lock.getAgentLockStatus(GUILD);
    expect(status.active).toBe(true);
    expect(status.keyName).toBe('Claude');
    expect(status.pageIds).toEqual(['clx1234567890abcdefghijk']);
    expect(lock.isSiteAgentLocked(GUILD)).toBe(true);
  });

  test('l’agent rend la main', () => {
    lock.beginAgentWrite(GUILD, 'Claude', 'x');
    expect(lock.releaseAgentLock(GUILD)).toBe(true);
    expect(lock.isSiteAgentLocked(GUILD)).toBe(false);
  });

  test('interrompu, l’agent ne peut plus écrire et l’interruption est journalisée', async () => {
    lock.beginAgentWrite(GUILD, 'Claude', 'x');
    const status = await lock.interruptAgent(GUILD, { id: '1', name: 'Elouan' });
    expect(status.active).toBe(false);
    expect(status.interrupted?.byName).toBe('Elouan');
    expect(auditRows).toHaveLength(1);
    expect(() => lock.beginAgentWrite(GUILD, 'Claude', 'y')).toThrow(lock.AgentLockError);
  });

  test('réautorisé, l’agent peut reprendre', async () => {
    await lock.interruptAgent(GUILD, { id: '1', name: 'Elouan' });
    lock.allowAgentAgain(GUILD);
    expect(() => lock.beginAgentWrite(GUILD, 'Claude', 'y')).not.toThrow();
  });

  test('le verrou tombe seul après inactivité', () => {
    const realNow = Date.now;
    try {
      lock.beginAgentWrite(GUILD, 'Claude', 'x');
      const start = realNow();
      Date.now = () => start + lock.AGENT_IDLE_MS + 1;
      expect(lock.isSiteAgentLocked(GUILD)).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });
});
