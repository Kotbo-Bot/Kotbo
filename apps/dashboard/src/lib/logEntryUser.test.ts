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

  test("l'identifiant de l'auteur se retrouve à côté de son pseudo dans les détails", () => {
    // Logs avancés : la colonne n'a que le pseudo, les détails le citent avec sa mention.
    const entry = {
      user: 'alice',
      details: `Salon: <#333333333333333333> | Auteur: alice (<@${ACTOR}>) | Supprimé par: alice (<@${ACTOR}>) | Contenu: salut`,
    };
    expect(logEntryUser(entry)).toEqual({ name: 'alice', userId: ACTOR });
  });

  test("la mention d'un autre membre dans les détails n'est pas prise pour l'auteur", () => {
    const entry = {
      user: 'modo.test',
      details: `Salon: <#333333333333333333> | Auteur: alice (<@${TARGET}>) | Supprimé par: modo.test (<@${ACTOR}>)`,
    };
    expect(logEntryUser(entry)).toEqual({ name: 'modo.test', userId: ACTOR });
    expect(logEntryUser({ ...entry, user: 'Système' })).toEqual({ name: 'Système', userId: null });
  });

  test("l'identifiant entre parenthèses de l'auteur est reconnu et masqué", () => {
    const entry = { user: `Modo (${ACTOR})`, details: '' };
    expect(logEntryUser(entry)).toEqual({ name: 'Modo', userId: ACTOR });
  });
});
