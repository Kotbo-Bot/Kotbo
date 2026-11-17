import { describe, expect, test } from 'bun:test';
import { ApplicationCommandType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { globalContextCommands, guildContextCommands } from '../../commands';
import {
  contextActions,
  getAction,
  parseDuration,
  visibleActions,
  type ContextActionScope,
} from '../../services/core/contextActionRegistry';

/** Discord plafonne chaque scope (global / par guilde) à 5 menus User et 5 Message. */
const DISCORD_CONTEXT_MENU_CAP = 5;

function countByType(commands: { data: { toJSON: () => unknown } }[], type: ApplicationCommandType) {
  return commands.filter((cmd) => (cmd.data.toJSON() as { type?: number }).type === type).length;
}

/** Membre factice : seules les permissions et l'id sont lus par visibleActions. */
function fakeMember(id: string, ...permissions: bigint[]) {
  return {
    id,
    permissions: new PermissionsBitField(permissions),
  } as unknown as Parameters<typeof visibleActions>[1];
}

describe('quota des menus contextuels Discord', () => {
  test('les menus User globaux ne dépassent pas le plafond Discord', () => {
    expect(countByType(globalContextCommands, ApplicationCommandType.User)).toBeLessThanOrEqual(DISCORD_CONTEXT_MENU_CAP);
  });

  test('les menus Message globaux ne dépassent pas le plafond Discord', () => {
    expect(countByType(globalContextCommands, ApplicationCommandType.Message)).toBeLessThanOrEqual(DISCORD_CONTEXT_MENU_CAP);
  });

  test('les menus de guilde ne dépassent pas le plafond Discord', () => {
    expect(countByType(guildContextCommands, ApplicationCommandType.User)).toBeLessThanOrEqual(DISCORD_CONTEXT_MENU_CAP);
    expect(countByType(guildContextCommands, ApplicationCommandType.Message)).toBeLessThanOrEqual(DISCORD_CONTEXT_MENU_CAP);
  });

  test('un même nom ne collide pas au sein d\'un même type', () => {
    for (const type of [ApplicationCommandType.User, ApplicationCommandType.Message]) {
      const names = [...globalContextCommands, ...guildContextCommands]
        .filter((cmd) => (cmd.data.toJSON() as { type?: number }).type === type)
        .map((cmd) => cmd.data.name);
      expect(names.length).toBe(new Set(names).size);
    }
  });
});

describe('registre des actions contextuelles', () => {
  test('chaque action a un id unique dans son scope', () => {
    for (const scope of ['user', 'message'] as ContextActionScope[]) {
      const ids = contextActions.filter((a) => a.scope === scope).map((a) => a.id);
      expect(ids.length).toBe(new Set(ids).size);
    }
  });

  test('chaque scope tient dans les 25 options d\'un select Discord', () => {
    for (const scope of ['user', 'message'] as ContextActionScope[]) {
      expect(contextActions.filter((a) => a.scope === scope).length).toBeLessThanOrEqual(25);
    }
  });

  test('les libellés et descriptions respectent les limites Discord', () => {
    for (const action of contextActions) {
      expect(action.label.length).toBeLessThanOrEqual(100);
      expect(`${action.category} · ${action.description}`.length).toBeLessThanOrEqual(100);
    }
  });

  test('getAction distingue les scopes', () => {
    // « rep » existe dans les deux scopes : chacun doit renvoyer le sien.
    expect(getAction('user', 'rep')?.scope).toBe('user');
    expect(getAction('message', 'rep')?.scope).toBe('message');
    expect(getAction('user', 'translate')).toBeUndefined();
  });
});

describe('filtrage par permissions', () => {
  test('un membre sans permission ne voit que les actions ouvertes', () => {
    const visible = visibleActions('user', fakeMember('member-1'), 'target-1');
    expect(visible.every((a) => a.permission === undefined)).toBe(true);
    expect(visible.some((a) => a.id === 'rank')).toBe(true);
    expect(visible.some((a) => a.id === 'timeout')).toBe(false);
  });

  test('un modérateur voit les actions de modération', () => {
    const visible = visibleActions('user', fakeMember('mod-1', PermissionFlagsBits.ModerateMembers), 'target-1');
    expect(visible.some((a) => a.id === 'timeout')).toBe(true);
    expect(visible.some((a) => a.id === 'alt')).toBe(true);
    // ManageGuild non accordé : l'historique d'invitation reste masqué.
    expect(visible.some((a) => a.id === 'invites')).toBe(false);
  });

  test('les actions interdites sur soi-même sont masquées', () => {
    const self = visibleActions('user', fakeMember('same-id'), 'same-id');
    expect(self.some((a) => a.id === 'rep')).toBe(false);

    const other = visibleActions('user', fakeMember('same-id'), 'other-id');
    expect(other.some((a) => a.id === 'rep')).toBe(true);
  });
});

describe('parseDuration', () => {
  test('accepte les formats courants', () => {
    expect(parseDuration('10m')).toBe(10 * 60 * 1000);
    expect(parseDuration('2h')).toBe(2 * 60 * 60 * 1000);
    expect(parseDuration('1d')).toBe(24 * 60 * 60 * 1000);
    expect(parseDuration('1j')).toBe(24 * 60 * 60 * 1000);
    expect(parseDuration(' 30 S ')).toBe(30 * 1000);
  });

  test('rejette les entrées invalides', () => {
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('abc')).toBeNull();
    expect(parseDuration('10')).toBeNull();
    expect(parseDuration('0m')).toBeNull();
    expect(parseDuration('10y')).toBeNull();
  });

  test('rejette au-delà du plafond Discord de 28 jours', () => {
    expect(parseDuration('28d')).toBe(28 * 24 * 60 * 60 * 1000);
    expect(parseDuration('29d')).toBeNull();
  });
});
