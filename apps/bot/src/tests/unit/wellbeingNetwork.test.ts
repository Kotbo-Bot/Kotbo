import { describe, expect, test } from 'bun:test';
import {
  networkPoolCandidates,
  networkReferentAllowed,
  networkReferentError,
  sharesNetworkPool,
} from '../../services/staff/wellbeingNetworkPolicy';
import { describeConfigChange } from '../../services/staff/wellbeingAccessPolicy';
import { isSynced } from '../../services/network/networkScope';

const HOME = '900000000000000001';
const OTHER = '900000000000000002';
const THIRD = '900000000000000003';

describe('partage des référents du réseau', () => {
  test('une cellule partage seulement si elle est active et a choisi le partage', () => {
    expect(sharesNetworkPool({ enabled: true, networkPool: true })).toBe(true);
    expect(sharesNetworkPool({ enabled: false, networkPool: true })).toBe(false);
    expect(sharesNetworkPool({ enabled: true, networkPool: false })).toBe(false);
    expect(sharesNetworkPool({ enabled: true })).toBe(false);
    expect(sharesNetworkPool(null)).toBe(false);
  });

  test("le changement du partage entre au journal d'audit", () => {
    const base = { enabled: true, requireReason: true, teamRoleIds: [], teamUserIds: [], directorRoleIds: [], directorUserIds: [] };
    expect(describeConfigChange({ ...base, networkPool: false }, { ...base, networkPool: true }, (id) => id))
      .toBe('Référents du réseau : partagés');
    expect(describeConfigChange({ ...base, networkPool: true }, { ...base, networkPool: false }, (id) => id))
      .toBe('Référents du réseau : plus partagés');
  });
});

describe('candidats du réseau', () => {
  const cells = [
    { guildId: HOME, memberIds: ['local-1'] },
    { guildId: OTHER, memberIds: ['ext-1', 'ext-2', 'subject'] },
    { guildId: THIRD, memberIds: ['ext-3', 'ext-1', 'local-1'] },
  ];

  test("les membres des autres cellules, sans la cellule d'origine", () => {
    expect(networkPoolCandidates(cells, HOME, [])).toEqual([
      { userId: 'ext-1', guildId: OTHER },
      { userId: 'ext-2', guildId: OTHER },
      { userId: 'subject', guildId: OTHER },
      { userId: 'ext-3', guildId: THIRD },
    ]);
  });

  test('la personne concernée et les membres de la cellule d origine sont écartés', () => {
    const ids = networkPoolCandidates(cells, HOME, ['subject', 'local-1']).map((c) => c.userId);
    expect(ids).toEqual(['ext-1', 'ext-2', 'ext-3']);
  });

  test('un membre de deux cellules ne figure qu une fois', () => {
    expect(networkPoolCandidates(cells, HOME, []).filter((c) => c.userId === 'ext-1')).toHaveLength(1);
  });
});

describe('désignation du référent du réseau', () => {
  const pool = [{ userId: 'ext-1', guildId: OTHER }];

  test('un candidat du réseau est accepté', () => {
    expect(networkReferentError({ userId: 'ext-1', guildId: OTHER }, pool, 'subject')).toBeNull();
  });

  test('la personne concernée ne suit pas son dossier', () => {
    expect(networkReferentError({ userId: 'subject', guildId: OTHER }, [...pool, { userId: 'subject', guildId: OTHER }], 'subject'))
      .not.toBeNull();
  });

  test('un membre hors du réseau, ou rattaché à une autre cellule, est refusé', () => {
    expect(networkReferentError({ userId: 'inconnu', guildId: OTHER }, pool, null)).not.toBeNull();
    expect(networkReferentError({ userId: 'ext-1', guildId: THIRD }, pool, null)).not.toBeNull();
  });
});

describe("accès du référent du réseau", () => {
  const ok = {
    assigned: true,
    sameNetwork: true,
    caseCellShares: true,
    homeCellShares: true,
    isHomeTeamMember: true,
    isSubject: false,
  };

  test('tout est réuni : il lit le dossier', () => {
    expect(networkReferentAllowed(ok)).toBe(true);
  });

  test("chaque condition retirée ferme l'accès", () => {
    for (const key of ['assigned', 'sameNetwork', 'caseCellShares', 'homeCellShares', 'isHomeTeamMember'] as const) {
      expect(networkReferentAllowed({ ...ok, [key]: false })).toBe(false);
    }
    expect(networkReferentAllowed({ ...ok, isSubject: true })).toBe(false);
  });
});

describe('cloisonnement des données du réseau', () => {
  test('signaux de détresse et météo du staff restent sur leur serveur', () => {
    // Partagés, les signaux d'un sous-serveur iraient à la cellule du principal.
    for (const model of ['WellbeingDistressSignal', 'WellbeingPulseWeek', 'WellbeingPulseVoter']) {
      expect(isSynced(model)).toBe(false);
    }
  });
});
