/**
 * Menus de rôles tout prêts : choisir un modèle ne fait que proposer des rôles.
 * Ceux qui manquent ne sont créés qu'à la publication du menu, sans aucune
 * permission ; ceux qui existent déjà sous le même nom sont repris.
 */

import { describe, expect, it, mock } from 'bun:test';
import type { Guild } from 'discord.js';
import { hasNewRoles, materializeNewRoles, presetDefinition, previewReactionRolePreset } from '../../services/features/reactionRolePresets.js';

type FakeRole = { id: string; name: string; managed?: boolean; permissions?: { bitfield: bigint } };

function fakeGuild(existing: FakeRole[] = []) {
  let next = 0;
  const roles = new Map(existing.map((role) => [role.id, { managed: false, permissions: { bitfield: 0n }, ...role }]));
  const create = mock(async (input: { name: string; color?: number; permissions?: unknown[] }) => {
    const role = { id: `cree-${++next}`, name: input.name, managed: false, permissions: { bitfield: 0n } };
    roles.set(role.id, role);
    return role;
  });
  const guild = {
    roles: {
      cache: { find: (match: (role: Required<FakeRole>) => boolean) => [...roles.values()].find(match) },
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

describe('previewReactionRolePreset', () => {
  it('ne crée aucun rôle : les rôles manquants sont seulement proposés', () => {
    const { guild, create } = fakeGuild();

    const preview = previewReactionRolePreset(guild, 'colors', 'fr');

    const expected = presetDefinition('colors', 'fr');
    expect(create).not.toHaveBeenCalled();
    expect(preview.options[0]).toEqual({
      label: expected.roles[0]!.name,
      roleId: '',
      newRole: { name: expected.roles[0]!.name, color: expected.roles[0]!.color },
    });
  });

  it('reprend un rôle existant du même nom', () => {
    const name = presetDefinition('colors', 'fr').roles[0]!.name;
    const { guild } = fakeGuild([{ id: 'deja-la', name }]);

    expect(previewReactionRolePreset(guild, 'colors', 'fr').options[0]).toEqual({ label: name, roleId: 'deja-la' });
  });

  it('ne reprend pas un rôle géré par une intégration, que Discord interdit d’attribuer', () => {
    const name = presetDefinition('colors', 'fr').roles[0]!.name;
    const { guild } = fakeGuild([{ id: 'integration', name, managed: true }]);

    expect(previewReactionRolePreset(guild, 'colors', 'fr').options[0]!.roleId).toBe('');
  });

  it('ne reprend pas un rôle du même nom qui porte des permissions : le menu le donnerait à tous', () => {
    const name = presetDefinition('notifications', 'fr').roles[0]!.name;
    const { guild } = fakeGuild([{ id: 'admin-mal-nomme', name, permissions: { bitfield: 8n } }]);

    expect(previewReactionRolePreset(guild, 'notifications', 'fr').options[0]!.roleId).toBe('');
  });
});

describe('materializeNewRoles', () => {
  it('crée à la publication les rôles proposés, sans permission', async () => {
    const { guild, create } = fakeGuild();

    const result = await materializeNewRoles(guild, [
      { label: 'Rouge', roleId: '', newRole: { name: 'Rouge', color: 0xe74c3c } },
      { label: 'Annonces', roleId: 'existant' },
    ]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Rouge', color: 0xe74c3c, permissions: [] }));
    expect(result.createdRoles).toBe(1);
    expect(result.options).toEqual([
      { label: 'Rouge', roleId: 'cree-1' },
      { label: 'Annonces', roleId: 'existant' },
    ]);
  });

  it('un rôle choisi à la main l’emporte sur le rôle proposé', async () => {
    const { guild, create } = fakeGuild();

    const result = await materializeNewRoles(guild, [{ label: 'Rouge', roleId: 'choisi', newRole: { name: 'Rouge' } }]);

    expect(create).not.toHaveBeenCalled();
    expect(result.options).toEqual([{ label: 'Rouge', roleId: 'choisi' }]);
  });

  it('un rôle du même nom apparu entre-temps est repris au lieu d’être doublé', async () => {
    const { guild, create } = fakeGuild([{ id: 'deja-la', name: 'Rouge' }]);

    const result = await materializeNewRoles(guild, [{ label: 'Rouge', roleId: '', newRole: { name: 'Rouge' } }]);

    expect(create).not.toHaveBeenCalled();
    expect(result.createdRoles).toBe(0);
    expect(result.options[0]!.roleId).toBe('deja-la');
  });

  it('ne reprend pas en douce un rôle du même nom qui porte des permissions', async () => {
    const { guild, create } = fakeGuild([{ id: 'admin-mal-nomme', name: 'Annonces', permissions: { bitfield: 8n } }]);

    const result = await materializeNewRoles(guild, [{ label: 'Annonces', roleId: '', newRole: { name: 'Annonces' } }]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(result.options[0]!.roleId).not.toBe('admin-mal-nomme');
  });

  it('nettoie le rôle reçu du navigateur : nom coupé à 100 caractères, couleur invalide ignorée', async () => {
    const { guild, create } = fakeGuild();

    await materializeNewRoles(guild, [{ label: 'X', roleId: '', newRole: { name: `  ${'a'.repeat(150)}  `, color: -4 } }]);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: 'a'.repeat(100), color: undefined }));
  });

  it('un rôle proposé sans nom n’est pas créé', async () => {
    const { guild, create } = fakeGuild();

    const result = await materializeNewRoles(guild, [{ label: 'X', roleId: '', newRole: { name: '   ' } }]);

    expect(create).not.toHaveBeenCalled();
    expect(result.options).toEqual([{ label: 'X', roleId: '' }]);
  });

  it('sans rôle à créer, ne touche pas au serveur', async () => {
    const { guild, create } = fakeGuild();

    const result = await materializeNewRoles(guild, [{ label: 'Annonces', roleId: 'existant' }]);

    expect(create).not.toHaveBeenCalled();
    expect(result).toEqual({ options: [{ label: 'Annonces', roleId: 'existant' }], createdRoles: 0 });
  });
});

describe('hasNewRoles', () => {
  it('repère un bouton qui attend la création de son rôle', () => {
    expect(hasNewRoles([{ label: 'Rouge', roleId: '', newRole: { name: 'Rouge' } }])).toBeTrue();
  });

  it('ignore un rôle proposé sans nom', () => {
    expect(hasNewRoles([{ label: 'X', roleId: '', newRole: { name: ' ' } }])).toBeFalse();
  });

  it('ignore un bouton dont le rôle est déjà choisi', () => {
    expect(hasNewRoles([{ label: 'Rouge', roleId: 'choisi', newRole: { name: 'Rouge' } }])).toBeFalse();
    expect(hasNewRoles([{ label: 'Annonces', roleId: 'existant' }])).toBeFalse();
  });
});
