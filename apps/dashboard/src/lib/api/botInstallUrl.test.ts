import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

mock.module(path.resolve(import.meta.dir, 'client.ts'), () => ({ API_BASE_URL: 'https://api.test' }));

const { buildBotInstallUrl } = await import('./servers');

describe('lien d’installation du dashboard', () => {
  test('Administrateur par défaut, avec retour demandé au bot', () => {
    const url = new URL(buildBotInstallUrl('223456789012345678'));
    expect(url.origin + url.pathname).toBe('https://api.test/api/public/invite');
    expect(Object.fromEntries(url.searchParams)).toEqual({ return: '1', perms: 'admin', guild_id: '223456789012345678' });
  });

  test('sans serveur choisi, permissions au détail', () => {
    const url = new URL(buildBotInstallUrl(undefined, 'detailed'));
    expect(url.searchParams.get('perms')).toBe('detailed');
    expect(url.searchParams.has('guild_id')).toBe(false);
  });
});
