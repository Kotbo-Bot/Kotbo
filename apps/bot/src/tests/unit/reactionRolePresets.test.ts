/**
 * Menus de rôles tout prêts : les rôles manquants sont créés sans aucune
 * permission, ceux qui existent déjà sous le même nom sont repris.
 */

import { describe, expect, it, mock } from 'bun:test';
import type { Guild } from 'discord.js';
import { applyReactionRolePreset, presetDefinition } from '../../services/features/reactionRolePresets.js';

function fakeGuild(existing: Array<{ id: string; name: string; managed?: boolean }> = []) {
  let next = 0;
  const roles = new Map(existing.map((role) => [role.id, { managed: false, ...role }]));
  const create = mock(async (input: { name: string; color?: number; permissions?: unknown[] }) => {
    const role = { id: `cree-${++next}`, name: input.name, managed: false };
    roles.set(role.id, role);
    return role;
  });
  const guild = {
    roles: {
      cache: { find: (match: (role: { name: string; managed: boolean }) => boolean) => [...roles.values()].find(match) },
      create,
    },
  } as unknown as Guild;
  return { guild, create };
}

describe('presetDefinition', () => {
  it('les couleurs forment un menu « un seul rôle », chaque rôle avec sa couleur', () => {
    const preset = presetDefinition('colors', 'fr');
    expect(preset.buttonMode).toBe('exclusive');
    expect(preset.roles.length).toBeGreaterThan(1);
    expect(preset.roles.every((role) => typeof role.color === 'number')).toBeTrue();
  });

  it('pronoms et notifications se cumulent : menu en bascule', () => {
    expect(presetDefinition('pronouns', 'fr').buttonMode).toBe('toggle');
    expect(presetDefinition('notifications', 'fr').buttonMode).toBe('toggle');
  });

  it('les noms suivent la langue du serveur', () => {
    expect(presetDefinition('colors', 'fr').roles[0]!.name).not.toBe(presetDefinition('colors', 'en').roles[0]!.name);
  });
});

describe('applyReactionRolePreset', () => {
  it('crée les rôles manquants sans permission et remplit les boutons', async () => {
    const { guild, create } = fakeGuild();

    const result = await applyReactionRolePreset(guild, 'notifications', 'fr');

    const expected = presetDefinition('notifications', 'fr');
    expect(create).toHaveBeenCalledTimes(expected.roles.length);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: expected.roles[0]!.name, permissions: [] }));
    expect(result.createdRoles).toBe(expected.roles.length);
    expect(result.options.map((option) => option.label)).toEqual(expected.roles.map((role) => role.name));
    expect(result.options.every((option) => option.roleId.startsWith('cree-'))).toBeTrue();
  });

  it('reprend un rôle existant du même nom au lieu de le doubler', async () => {
    const name = presetDefinition('colors', 'fr').roles[0]!.name;
    const { guild, create } = fakeGuild([{ id: 'deja-la', name }]);

    const result = await applyReactionRolePreset(guild, 'colors', 'fr');

    expect(result.options[0]!.roleId).toBe('deja-la');
    expect(create).not.toHaveBeenCalledWith(expect.objectContaining({ name }));
    expect(result.createdRoles).toBe(presetDefinition('colors', 'fr').roles.length - 1);
  });

  it('ne reprend pas un rôle géré par une intégration, que Discord interdit d’attribuer', async () => {
    const name = presetDefinition('colors', 'fr').roles[0]!.name;
    const { guild } = fakeGuild([{ id: 'integration', name, managed: true }]);

    const result = await applyReactionRolePreset(guild, 'colors', 'fr');

    expect(result.options[0]!.roleId).not.toBe('integration');
  });
});
