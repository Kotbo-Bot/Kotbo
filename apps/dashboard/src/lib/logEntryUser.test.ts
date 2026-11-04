import { describe, expect, test } from 'bun:test';
import { logEntryUser } from './logEntryUser';

const ACTOR = '111111111111111111';
const TARGET = '222222222222222222';

describe("membre d'une ligne de journal", () => {
  test("une mention dans les détails ne remplace pas l'auteur affiché", () => {
    // Menu contextuel lancé par ACTOR sur TARGET : la colonne montre ACTOR, la fiche aussi.
    const entry = {
      user: `Modo#0001 (<@${ACTOR}>)`,
      details: `Commande de menu contextuel "Avertir" exécutée sur l'utilisateur <@${TARGET}> (${TARGET}).`,
    };
    expect(logEntryUser(entry)).toEqual({ name: 'Modo#0001', userId: ACTOR });
  });

  test('un membre en tête des détails donne nom et identifiant', () => {
    const entry = { user: 'Kotbo', details: `Alice (<@${TARGET}>) | Salon: <#333333333333333333>` };
    expect(logEntryUser(entry)).toEqual({ name: 'Alice', userId: TARGET });
  });

  test("un auteur sans identifiant ouvre la fiche sur son seul nom", () => {
    const entry = { user: 'Modo', details: `Rôle retiré à <@${TARGET}>` };
    expect(logEntryUser(entry)).toEqual({ name: 'Modo', userId: null });
  });

  test("l'identifiant entre parenthèses de l'auteur est reconnu et masqué", () => {
    const entry = { user: `Modo (${ACTOR})`, details: '' };
    expect(logEntryUser(entry)).toEqual({ name: 'Modo', userId: ACTOR });
  });
});
