/**
 * La cellule se compose aussi par rôles Discord, qui se donnent hors de
 * Kotbo. Seul le propriétaire doit pouvoir y faire entrer quelqu'un, et chaque
 * changement d'appartenance doit se voir.
 */
import { describe, expect, test } from 'bun:test';
import {
  alertText,
  cellMembershipChanges,
  roleDeltaFromChanges,
  shouldRevertCellRoleGrant,
  type WellbeingAccessLists,
} from '../../services/staff/wellbeingPolicy';

const config: WellbeingAccessLists = {
  enabled: true,
  requireReason: true,
  teamRoleIds: ['team'],
  teamUserIds: [],
  directorRoleIds: ['direction'],
  directorUserIds: [],
};

describe("lecture d'une entrée d'audit de rôles", () => {
  test('les rôles ajoutés et retirés sont extraits', () => {
    expect(roleDeltaFromChanges([
      { key: '$add', new: [{ id: 'team', name: 'Écoute' }] },
      { key: '$remove', new: [{ id: 'autre', name: 'Autre' }] },
    ])).toEqual({ added: ['team'], removed: ['autre'] });
  });

  test('une entrée sans changement de rôle ne donne rien', () => {
    expect(roleDeltaFromChanges([{ key: 'nick', new: 'x' }])).toEqual({ added: [], removed: [] });
    expect(roleDeltaFromChanges(undefined)).toEqual({ added: [], removed: [] });
  });
});

describe('changements qui touchent la cellule', () => {
  test("seuls les rôles de la cellule et de la direction comptent, avec leur portée", () => {
    expect(cellMembershipChanges(config, { added: ['team', 'autre'], removed: ['direction'] })).toEqual([
      { roleId: 'team', scope: 'team', change: 'added' },
      { roleId: 'direction', scope: 'direction', change: 'removed' },
    ]);
  });

  test('une cellule sans configuration ne réagit à rien', () => {
    expect(cellMembershipChanges(null, { added: ['team'], removed: [] })).toEqual([]);
  });
});

describe("annulation d'un ajout", () => {
  test('seul le propriétaire peut donner un rôle de la cellule', () => {
    expect(shouldRevertCellRoleGrant('owner', 'owner')).toBe(false);
    expect(shouldRevertCellRoleGrant('admin', 'owner')).toBe(true);
    // Kotbo lui-même (niveaux, boutique, menus de rôles, workflows...) n'y échappe pas.
    expect(shouldRevertCellRoleGrant('bot', 'owner')).toBe(true);
    // Auteur inconnu : on annule plutôt que de laisser entrer.
    expect(shouldRevertCellRoleGrant(null, 'owner')).toBe(true);
  });
});

describe("alerte d'appartenance", () => {
  test("elle nomme l'auteur, le membre et dit si l'ajout a été annulé", () => {
    const text = alertText('MEMBERSHIP_CHANGE', { actorId: '1', targetId: '2', change: 'added', scope: 'team', reverted: true });
    expect(text).toContain('<@1>');
    expect(text).toContain('<@2>');
    expect(text).toContain('annul');
  });

  test("un retrait est signalé sans être annulé", () => {
    const text = alertText('MEMBERSHIP_CHANGE', { actorId: '1', targetId: '2', change: 'removed', scope: 'direction' });
    expect(text).toContain('direction');
    expect(text).not.toContain('annul');
  });
});

describe('outils MCP qui touchent aux rôles', () => {
  test('add_role, remove_role et manage_member_roles refusent un rôle de la cellule avant de le toucher', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const read = (file: string) => readFileSync(path.resolve(import.meta.dir, '../../api/mcp/tools', file), 'utf8');
    for (const [file, tool, write] of [
      ['write-members.ts', "'add_role'", 'roles.add('],
      ['write-members.ts', "'remove_role'", 'roles.remove('],
      ['write-members-new.ts', "'manage_member_roles'", 'discordMember.roles.'],
    ] as const) {
      const source = read(file);
      const body = source.slice(source.indexOf(tool));
      const guard = body.indexOf('cellRoleIds(');
      expect(guard).toBeGreaterThan(-1);
      expect(guard).toBeLessThan(body.indexOf(write));
    }
  });
});
