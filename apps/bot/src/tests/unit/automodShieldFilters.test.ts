import { describe, expect, test } from 'bun:test';
import type { FileFilterRule, RaidProtectionConfig } from '@prisma/client';
import type { GuildBasedChannel } from 'discord.js';
import { extractGuildLinks, extractInviteCodes, isRefused } from '../../services/moderation/otherServersFilter.js';
import { extensionOf, normalizeExtensions, resolveRule } from '../../services/moderation/fileExtensionFilter.js';

const OWN = '100000000000000001';
const PARTNER = '200000000000000002';
const OTHER = '300000000000000003';

describe('autres serveurs : listes', () => {
  const listed = new Set([PARTNER]);

  test('le serveur lui-même passe toujours', () => {
    expect(isRefused('WHITELIST', OWN, OWN, new Set())).toBe(false);
  });

  test('liste noire : seuls les serveurs listés sont refusés', () => {
    expect(isRefused('BLACKLIST', PARTNER, OWN, listed)).toBe(true);
    expect(isRefused('BLACKLIST', OTHER, OWN, listed)).toBe(false);
    expect(isRefused('BLACKLIST', null, OWN, listed)).toBe(false);
  });

  test('liste blanche : seuls les serveurs listés passent, une invitation invérifiable est refusée', () => {
    expect(isRefused('WHITELIST', PARTNER, OWN, listed)).toBe(false);
    expect(isRefused('WHITELIST', OTHER, OWN, listed)).toBe(true);
    expect(isRefused('WHITELIST', null, OWN, listed)).toBe(true);
  });

  test('désactivé : rien n\'est refusé', () => {
    expect(isRefused('OFF', OTHER, OWN, listed)).toBe(false);
  });
});

describe('autres serveurs : lecture des invitations', () => {
  test('lit les formes officielles, ptb et canary, et les invitations maquillées', () => {
    const codes = extractInviteCodes([
      'rejoins https://discord.gg/abcDEF',
      'https://ptb.discord.com/invite/raidzone',
      'canary.discordapp.com/invite/xyz-12',
      'discord . gg / cache',
    ]);
    expect(codes).toEqual(['abcDEF', 'raidzone', 'xyz-12', 'cache']);
  });

  test('ignore les liens Discord qui ne sont pas des invitations', () => {
    expect(extractInviteCodes(['https://discord.com/channels/1/2', 'https://discord.gift/nitro'])).toEqual([]);
  });

  test('repère les liens de salon et d\'événement d\'un serveur', () => {
    expect(extractGuildLinks([`https://discord.com/channels/${OTHER}/400000000000000004`, `https://ptb.discord.com/events/${PARTNER}/1`])).toEqual([OTHER, PARTNER]);
  });
});

describe('extensions de fichiers', () => {
  test('extensionOf et normalizeExtensions', () => {
    expect(extensionOf('setup.EXE')).toBe('exe');
    expect(extensionOf('sans-extension')).toBe('');
    expect(normalizeExtensions('.exe, msi  bat,, ../x')).toEqual(['exe', 'msi', 'bat']);
  });

  const config = { fileFilterMode: 'BLACKLIST', fileGroups: ['ARCHIVES'], fileExtensions: [] } as unknown as RaidProtectionConfig;
  const rule = (targetId: string, mode: string, extensions: string[]) => ({ targetId, mode, groups: [], extensions }) as unknown as FileFilterRule;
  const channel = (id: string, parentId: string | null) => ({ id, parentId, isThread: () => false }) as unknown as GuildBasedChannel;

  test('la règle la plus précise l\'emporte : salon, puis catégorie, puis serveur', () => {
    const rules = [rule('cat', 'WHITELIST', ['png']), rule('chan', 'BLACKLIST', ['exe'])];
    expect(resolveRule(channel('chan', 'cat'), rules, config)?.scope).toBe('salon');
    expect(resolveRule(channel('autre', 'cat'), rules, config)?.scope).toBe('catégorie');
    expect(resolveRule(channel('ailleurs', null), rules, config)?.scope).toBe('serveur');
  });

  test('sans règle et filtre désactivé, aucune règle ne s\'applique', () => {
    const off = { ...config, fileFilterMode: 'OFF' } as RaidProtectionConfig;
    expect(resolveRule(channel('x', null), [], off)).toBeNull();
  });
});
