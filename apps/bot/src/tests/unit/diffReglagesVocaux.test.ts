import { describe, expect, test } from 'bun:test';
import { diffReglagesVocaux, lignesDiffReglages, TEMP_VOICE_OWNERSHIP_DEFAULTS, type ReglagesVocaux } from '@kotbo/shared';

/**
 * `diffReglagesVocaux` : fonction pure partagée par l'audit du dashboard et,
 * côté bot, par l'embed Discord des changements de réglages.
 */

const GEN_A = '500000000000000001';
const GEN_B = '500000000000000002';
const ROLE = '800000000000000000';

function etat(): ReglagesVocaux {
  return {
    tempVoiceEnabled: true,
    tempVoiceChannelId: GEN_A,
    tempVoiceCategoryId: null,
    tempVoiceNameTemplate: 'Salon de {user}',
    tempVoiceRequiredRoleId: null,
    tempVoiceDefaults: { userLimit: 0, lockOnCreate: false, autoAllowRoleIds: [], textChat: 'inherit', ownerPowers: ['mute', 'deafen', 'move'] },
    tempVoiceGenerators: [],
    tempVoiceModPermissions: {
      canRename: true, canChangeLimit: true, canLock: true, canChangeWriteMode: true, canKickOrBan: true,
      canReserve: true, canTransfer: true, panelCompactMode: false, reservableRoleIds: [],
      reservationOverflow: 'ASK', reservationFallbackChannelId: null, panelMode: 'CLASSIC', stateLayout: 'GRID3',
      stateColors: 'NEUTRAL', panelComponents: 'V2', reservationFallbackMode: 'ANY_ROLE',
      perGeneratorPresentation: false, ownerMentionPlacement: 'panel', ...TEMP_VOICE_OWNERSHIP_DEFAULTS,
    },
    tempVoiceAccessRequest: {
      enabled: false, responders: 'OWNER_AND_STAFF', notifyVia: 'VOICE', notifyChannelId: null,
      requestExpiresMinutes: 10, denyCooldownMinutes: 10,
    },
  };
}

function avecMod(changes: Record<string, unknown>): ReglagesVocaux {
  const e = etat();
  return { ...e, tempVoiceModPermissions: { ...(e.tempVoiceModPermissions as object), ...changes } };
}

describe('diffReglagesVocaux', () => {
  test('deux états identiques : aucun changement', () => {
    expect(diffReglagesVocaux(etat(), etat())).toEqual([]);
  });

  test('un champ simple : libellé français, avant, après', () => {
    expect(diffReglagesVocaux(etat(), avecMod({ panelMode: 'FLAT' }))).toEqual([
      { champ: 'Panneau : mode', avant: 'CLASSIC', apres: 'FLAT' },
    ]);
  });

  test('ownerMentionPlacement fait partie du journal', () => {
    expect(lignesDiffReglages(diffReglagesVocaux(etat(), avecMod({ ownerMentionPlacement: 'message' })))).toEqual([
      'Mention du propriétaire : panel → message',
    ]);
  });

  test('booléens en oui/non, vide en « (aucun) »', () => {
    const apres = { ...etat(), tempVoiceEnabled: false, tempVoiceNameTemplate: '' };
    expect(diffReglagesVocaux(etat(), apres)).toEqual([
      { champ: 'Salons temporaires activés', avant: 'oui', apres: 'non' },
      { champ: 'Générateur principal : modèle de nom', avant: 'Salon de {user}', apres: '(aucun)' },
    ]);
  });

  test('objets imbriqués : tempVoiceDefaults.* champ par champ, listes comparées comme des ensembles', () => {
    const avant = etat();
    const apres = {
      ...etat(),
      tempVoiceDefaults: { userLimit: 5, lockOnCreate: true, autoAllowRoleIds: [ROLE], textChat: 'locked', ownerPowers: ['move', 'mute', 'deafen'] },
    };
    const champs = diffReglagesVocaux(avant, apres, { role: (id) => (id === ROLE ? 'Membres' : undefined) });
    expect(champs.map((c) => c.champ)).toEqual([
      'Générateur principal : places',
      'Générateur principal : créer verrouillé',
      'Générateur principal : rôles autorisés d\'office',
      'Générateur principal : chat textuel',
    ]);
    expect(champs[2]).toMatchObject({ avant: '(aucun)', apres: '@Membres' });
  });

  test('noms de salons quand le cache les connaît, id sinon', () => {
    const apres = { ...etat(), tempVoiceChannelId: GEN_B, tempVoiceCategoryId: '600000000000000000' };
    const [salon, categorie] = diffReglagesVocaux(etat(), apres, { salon: (id) => (id === GEN_B ? 'Créer B' : undefined) });
    expect(salon).toMatchObject({ avant: GEN_A, apres: '#Créer B' });
    expect(categorie).toMatchObject({ avant: '(aucun)', apres: '600000000000000000' });
  });

  test('générateurs : ajout, retrait, champ modifié, surcharge — clés par salon, l\'ordre ne compte pas', () => {
    const gen = (channelId: string, extra: object = {}) => ({
      channelId, nameTemplate: 'x', requiredRoleId: null, userLimit: 0, lockOnCreate: false, autoAllowRoleIds: [], textChat: 'inherit',
      ownerPowers: ['mute'], ...extra,
    });
    const avant = { ...etat(), tempVoiceGenerators: [gen(GEN_A), gen(GEN_B)] };

    expect(diffReglagesVocaux(avant, { ...etat(), tempVoiceGenerators: [gen(GEN_B), gen(GEN_A)] })).toEqual([]);

    const apres = { ...etat(), tempVoiceGenerators: [gen(GEN_A, { userLimit: 4, panelMode: 'FLAT' })] };
    expect(lignesDiffReglages(diffReglagesVocaux(avant, apres, { salon: (id) => (id === GEN_A ? 'A' : 'B') }))).toEqual([
      'Générateur #A : places : 0 → 4',
      'Générateur #A : panneau : mode : (aucun) → FLAT',
      'Générateur #B : présent → supprimé',
    ]);
    expect(lignesDiffReglages(diffReglagesVocaux(apres, avant))).toContain(`Générateur ${GEN_B} : (aucun) → ajouté`);
  });

  test('chaque réglage de modérateur, de demande d\'accès et de passation a un libellé (aucun chemin brut)', () => {
    const e = etat();
    const flips: Array<[string, Record<string, unknown>]> = [];
    for (const section of ['tempVoiceModPermissions', 'tempVoiceAccessRequest'] as const) {
      for (const [cle, valeur] of Object.entries(e[section] as Record<string, unknown>)) {
        const nouveau = typeof valeur === 'boolean' ? !valeur : typeof valeur === 'number' ? valeur + 1 : Array.isArray(valeur) ? [ROLE] : `${String(valeur)}-x`;
        flips.push([section, { [cle]: nouveau }]);
      }
    }
    for (const [section, patch] of flips) {
      const apres = { ...e, [section]: { ...(e[section] as object), ...patch } };
      const [changement, ...reste] = diffReglagesVocaux(e, apres);
      expect(reste).toHaveLength(0);
      expect(changement.champ).not.toContain('tempVoice');
    }
  });

  test('avant absent : tout ce qui est renseigné ressort comme changement', () => {
    expect(diffReglagesVocaux(null, etat()).length).toBeGreaterThan(10);
  });
});
