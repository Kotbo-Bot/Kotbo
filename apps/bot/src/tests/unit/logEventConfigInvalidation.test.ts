/**
 * Une sauvegarde de la configuration des logs depuis le dashboard écrivait en
 * base et **ne touchait jamais au cache**. La lecture, elle, met la
 * configuration de chaque événement en cache pour soixante secondes
 * (`advancedLogs.ts`). Résultat : la case décochée sur le dashboard continue
 * de produire des logs jusqu'à une minute, et la route répond `200` — rien
 * n'indique que le réglage n'est pas appliqué.
 *
 * C'est la même classe de défaut que le salon par défaut hors invalidation :
 * un réglage écrit, une lecture qui ne le voit pas.
 *
 * Aucun `mock.module` et aucune base : `enregistrerConfigsEvenements` reçoit
 * ses deux accès en argument, et le module qu'il vient n'importe ni Prisma ni
 * le cache. Donc pas de préfixe `zz-`.
 */
import { describe, expect, test } from 'bun:test';
import {
  cleConfigEvenement,
  enregistrerConfigsEvenements,
  type ConfigEvenementDemandee,
} from '../../utils/logEventConfig.js';

const GUILDE = 'guilde-1';

function ioEnregistre() {
  const journal: string[] = [];
  const ecrites: ConfigEvenementDemandee[][] = [];
  const oubliees: string[] = [];
  return {
    journal,
    ecrites,
    oubliees,
    io: {
      enregistrer: async (configs: ReadonlyArray<ConfigEvenementDemandee>) => {
        journal.push('enregistrer');
        ecrites.push([...configs]);
      },
      oublier: async (cle: string) => {
        journal.push(`oublier:${cle}`);
        oubliees.push(cle);
      },
    },
  };
}

function config(eventType: string, enabled = true): ConfigEvenementDemandee {
  return { eventType, enabled, channelId: null };
}

describe('cleConfigEvenement', () => {
  test('rend exactement la clé que la lecture du bot interroge', () => {
    // Écrite en toutes lettres à dessein : c'est le seul endroit du test qui
    // ne passe pas par la fonction. Si le format change, la lecture
    // (`advancedLogs.ts`) et l'invalidation changent ensemble — mais une
    // divergence avec le préfixe `guild:<id>:` sortirait la clé du champ de
    // `cache.invalidateGuild`, sans que rien d'autre ne le dise.
    expect(cleConfigEvenement(GUILDE, 'message_delete')).toBe('guild:guilde-1:log_event_config:message_delete');
  });
});

describe('enregistrerConfigsEvenements', () => {
  test('vide le cache de chaque événement enregistré', async () => {
    const { io, oubliees } = ioEnregistre();

    const cles = await enregistrerConfigsEvenements(io, GUILDE, [
      config('message_delete', false),
      config('member_join'),
      config('voice_move', false),
    ]);

    expect(oubliees).toEqual([
      'guild:guilde-1:log_event_config:message_delete',
      'guild:guilde-1:log_event_config:member_join',
      'guild:guilde-1:log_event_config:voice_move',
    ]);
    expect(cles).toEqual(oubliees);
  });

  test("écrit d'abord, invalide ensuite", async () => {
    // L'ordre inverse rouvrirait le défaut sous une forme plus rare : une
    // lecture qui tombe entre le vidage et l'écriture remet l'ancienne valeur
    // en cache pour soixante secondes.
    const { io, journal } = ioEnregistre();

    await enregistrerConfigsEvenements(io, GUILDE, [config('message_edit')]);

    expect(journal).toEqual(['enregistrer', 'oublier:guild:guilde-1:log_event_config:message_edit']);
  });

  test('un événement listé deux fois ne vide sa clé qu’une fois', async () => {
    const { io, oubliees, ecrites } = ioEnregistre();

    await enregistrerConfigsEvenements(io, GUILDE, [
      config('member_leave', true),
      config('member_leave', false),
    ]);

    // L'écriture reçoit la liste telle quelle — la dernière valeur gagne, comme
    // avant. Seule l'invalidation dédoublonne.
    expect(ecrites[0]).toHaveLength(2);
    expect(oubliees).toEqual(['guild:guilde-1:log_event_config:member_leave']);
  });

  test('une sauvegarde vide écrit un lot vide et ne vide aucune clé', async () => {
    const { io, journal, ecrites } = ioEnregistre();

    const cles = await enregistrerConfigsEvenements(io, GUILDE, []);

    expect(ecrites[0]).toEqual([]);
    expect(journal).toEqual(['enregistrer']);
    expect(cles).toEqual([]);
  });
});
