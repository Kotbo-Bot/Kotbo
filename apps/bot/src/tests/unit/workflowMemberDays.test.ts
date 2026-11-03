/**
 * Déclencheurs d'ancienneté et d'inactivité, et message tenu à jour.
 *
 * Les deux déclencheurs ne viennent pas d'un événement Discord : un balayage
 * périodique cherche les membres dont le seuil est tombé depuis le passage
 * précédent. Le message tenu à jour est publié une fois, puis modifié.
 */
import { describe, expect, test } from 'bun:test';
import { MAX_MEMBER_DAYS, readMemberDays, validateGraph, type WorkflowGraph } from '@kotbo/shared';
import { crossingRange, nextSweptUntil } from '../../services/features/workflow/memberDays';
import { keepMessage, serialized, type KeptMessage } from '../../services/features/workflow/keptMessage';

function node(id: string, type: string, config?: Record<string, unknown>) {
  return { id, type, position: { x: 0, y: 0 }, config };
}
function edge(source: string, sourceHandle: string, target: string, targetHandle: string) {
  return { id: `${source}.${sourceHandle}->${target}.${targetHandle}`, source, sourceHandle, target, targetHandle };
}

function tenure(days: unknown): WorkflowGraph {
  return {
    nodes: [node('t', 'OnMemberTenure', { days }), node('a', 'SendDM', { text: 'Merci !' })],
    edges: [edge('t', 'next', 'a', 'exec'), edge('t', 'member', 'a', 'member')],
  };
}

describe('nombre de jours des déclencheurs de membre', () => {
  test('lit le nombre de jours réglé', () => {
    expect(readMemberDays(tenure(30))).toBe(30);
    expect(readMemberDays(tenure('365'))).toBe(365);
  });

  test('refuse un nombre absent, nul ou au-delà du plafond', () => {
    for (const days of [undefined, 0, -3, 1.5, MAX_MEMBER_DAYS + 1, 'abc']) {
      expect(readMemberDays(tenure(days))).toBeNull();
      expect(validateGraph(tenure(days)).some((issue) => issue.code === 'INVALID_MEMBER_DAYS')).toBe(true);
    }
  });

  test('un nombre valide ne lève aucune erreur', () => {
    expect(validateGraph(tenure(30)).filter((issue) => issue.severity === 'error')).toEqual([]);
  });
});

describe('crossingRange', () => {
  const DAY = 86_400_000;
  const from = new Date('2026-11-10T10:00:00Z');
  const to = new Date('2026-11-10T10:10:00Z');

  test('vise les dates dont le seuil tombe entre deux balayages', () => {
    const range = crossingRange(from, to, 30);
    expect(range.gt.getTime()).toBe(from.getTime() - 30 * DAY);
    expect(range.lte.getTime()).toBe(to.getTime() - 30 * DAY);
  });
});

describe('nextSweptUntil', () => {
  const to = new Date('2026-11-10T10:10:00Z');
  const last = new Date('2026-10-11T10:05:00Z');

  test('avance jusqu au balayage quand tout a été traité', () => {
    expect(nextSweptUntil({ to, days: 30, found: 12, limit: 200, lastReference: last })).toEqual(to);
  });

  test('s arrête au dernier membre traité quand le lot est plein', () => {
    // Le reste sera pris au passage suivant, sans en sauter.
    expect(nextSweptUntil({ to, days: 30, found: 200, limit: 200, lastReference: last }))
      .toEqual(new Date(last.getTime() + 30 * 86_400_000));
  });
});

describe('keepMessage', () => {
  function deps(existing: KeptMessage | null, editable = true) {
    const calls: string[] = [];
    let saved: KeptMessage | null = existing;
    return {
      calls,
      saved: () => saved,
      deps: {
        load: async () => existing,
        save: async (ref: KeptMessage) => { calls.push(`save:${ref.messageId}`); saved = ref; },
        edit: async (ref: KeptMessage, text: string) => { calls.push(`edit:${ref.messageId}:${text}`); return editable; },
        send: async (channelId: string, text: string) => { calls.push(`send:${channelId}:${text}`); return 'm-new'; },
      },
    };
  }

  test('publie le message au premier passage et le retient', async () => {
    const run = deps(null);
    expect(await keepMessage('c1', 'Compteur : 1', run.deps)).toEqual({ channelId: 'c1', messageId: 'm-new' });
    expect(run.calls).toEqual(['send:c1:Compteur : 1', 'save:m-new']);
  });

  test('modifie le message retenu aux passages suivants', async () => {
    const run = deps({ channelId: 'c1', messageId: 'm1' });
    expect(await keepMessage('c1', 'Compteur : 2', run.deps)).toEqual({ channelId: 'c1', messageId: 'm1' });
    expect(run.calls).toEqual(['edit:m1:Compteur : 2']);
  });

  test('republie quand le message retenu a été supprimé', async () => {
    const run = deps({ channelId: 'c1', messageId: 'm1' }, false);
    expect((await keepMessage('c1', 'Compteur : 3', run.deps)).messageId).toBe('m-new');
    expect(run.calls).toEqual(['edit:m1:Compteur : 3', 'send:c1:Compteur : 3', 'save:m-new']);
  });

  test('republie dans le nouveau salon quand le salon a changé', async () => {
    const run = deps({ channelId: 'c1', messageId: 'm1' });
    expect(await keepMessage('c2', 'Compteur', run.deps)).toEqual({ channelId: 'c2', messageId: 'm-new' });
    expect(run.calls).toEqual(['send:c2:Compteur', 'save:m-new']);
  });
});

describe('serialized', () => {
  test('deux premiers passages simultanés ne publient qu un seul message', async () => {
    // Deux membres arrivés à la même seconde : sans file, chacun verrait
    // « aucun message retenu » et publierait le sien.
    let stored: KeptMessage | null = null;
    let sends = 0;
    const deps = {
      load: async () => stored,
      save: async (ref: KeptMessage) => { stored = ref; },
      edit: async () => true,
      send: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        sends += 1;
        return `m${sends}`;
      },
    };

    const [first, second] = await Promise.all([
      serialized('w1:n1', () => keepMessage('c1', 'A', deps)),
      serialized('w1:n1', () => keepMessage('c1', 'B', deps)),
    ]);

    expect(sends).toBe(1);
    expect(second).toEqual(first);
  });

  test('une erreur ne bloque pas les passages suivants', async () => {
    await expect(serialized('w1:n2', async () => { throw new Error('Discord indisponible'); })).rejects.toThrow();
    expect(await serialized('w1:n2', async () => 'ok')).toBe('ok');
  });
});
