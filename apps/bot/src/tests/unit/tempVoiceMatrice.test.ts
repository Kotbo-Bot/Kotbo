import { describe, expect, test } from 'bun:test';
import { OverwriteType, PermissionFlagsBits } from 'discord.js';
import { deduireModeEcriture } from '../../events/tempVoice.js';
import * as m from '../../lib/paraglide/messages.js';
import {
  buildCreationOverwrites,
  defaultTempVoicePolicy,
  libelleModeEcriture,
  modeEcritureDepuisTextChat,
  normalizeTempVoicePolicy,
  requiredBotPermissions,
  TEMP_VOICE_TEXT_CHAT_MODES,
  type TempVoiceTextChatMode,
} from '../../services/features/tempVoiceService.js';

/**
 * Matrice d'écriture des vocaux temporaires : pour chaque réglage de chat, chaque
 * catégorie, verrou et rôle d'office, on construit les surcharges avec le vrai code,
 * on calcule le droit effectif d'écrire comme Discord le fait, puis on lit le mode
 * que le panneau afficherait.
 */

const SEND = PermissionFlagsBits.SendMessages;
const EVERYONE = '100000000000000000';
const OWNER = '200000000000000000';
const ROLE = '300000000000000000';

type Categorie = 'A' | 'B';
type Surcharge = { id: string; type: OverwriteType; allow: bigint; deny: bigint };

const aSend = (bits: bigint) => (bits & SEND) === SEND;

/** A : la catégorie ne refuse rien. B : elle refuse SendMessages à @everyone. */
function surchargesCategorie(cat: Categorie) {
  return cat === 'B' ? [{ id: EVERYONE, type: OverwriteType.Role, allow: 0n, deny: SEND }] : [];
}

function construire(textChat: TempVoiceTextChatMode, cat: Categorie, lock: boolean, role: boolean): Surcharge[] {
  const policy = {
    ...defaultTempVoicePolicy(),
    textChat,
    lockOnCreate: lock,
    autoAllowRoleIds: role ? [ROLE] : [],
  };
  const brut = buildCreationOverwrites({
    everyoneRoleId: EVERYONE,
    ownerId: OWNER,
    inherited: surchargesCategorie(cat),
    policy,
  }) as unknown as Array<{ id: string; type: OverwriteType; allow?: bigint | number; deny?: bigint | number }>;
  return brut.map((o) => ({ id: o.id, type: o.type, allow: BigInt(o.allow ?? 0), deny: BigInt(o.deny ?? 0) }));
}

/**
 * Droit effectif d'écrire : base accordée → surcharge @everyone → surcharges de rôle
 * (deny puis allow) → surcharge du membre. La catégorie est déjà recopiée dans les
 * surcharges du salon, comme à la création.
 */
function peutEcrire(surcharges: Surcharge[], membreId: string, roles: string[]): boolean {
  let ok = true;
  const appliquer = (o?: Surcharge) => {
    if (!o) return;
    if (aSend(o.deny)) ok = false;
    if (aSend(o.allow)) ok = true;
  };
  appliquer(surcharges.find((o) => o.id === EVERYONE));
  const deRoles = surcharges.filter((o) => roles.includes(o.id));
  if (deRoles.some((o) => aSend(o.deny))) ok = false;
  if (deRoles.some((o) => aSend(o.allow))) ok = true;
  appliquer(surcharges.find((o) => o.id === membreId && o.type === OverwriteType.Member));
  return ok;
}

const lire = (o?: Surcharge) =>
  o && { allow: { has: (b: bigint) => (o.allow & b) === b }, deny: { has: (b: bigint) => (o.deny & b) === b } };

/** Mode que lit le panneau : le mode mémorisé du réglage, sinon la déduction sur l'état réel. */
function modePanneau(textChat: TempVoiceTextChatMode, surcharges: Surcharge[], tousPeuventEcrire: boolean) {
  return (
    modeEcritureDepuisTextChat(textChat) ??
    deduireModeEcriture(
      lire(surcharges.find((o) => o.id === EVERYONE)),
      lire(surcharges.find((o) => o.id === OWNER)),
      tousPeuventEcrire,
    )
  );
}

// textChat, catégorie, lock, rôle d'office,
// écriture effective (inconnu hors vocal, propriétaire, membre du rôle ; null = non jugé),
// @everyone allow/deny SendMessages, propriétaire allow, rôle allow, mode du panneau, SendMessages du bot.
type Cas = [
  TempVoiceTextChatMode, Categorie, boolean, boolean,
  boolean, boolean | null, boolean | null,
  boolean, boolean, boolean, boolean | null,
  ReturnType<typeof modePanneau>, boolean,
];

const CAS: Cas[] = [
  ['inherit', 'A', false, false, true, true, null, false, false, false, null, 'everyone', false],
  ['inherit', 'A', false, true, true, true, true, false, false, false, true, 'everyone', true],
  ['inherit', 'B', false, false, false, false, null, false, true, false, null, 'nobody', false],
  ['inherit', 'B', false, true, false, false, true, false, true, false, true, 'nobody', true],
  ['open', 'A', false, false, true, true, null, true, false, false, null, 'everyone', true],
  ['open', 'A', false, true, true, true, true, true, false, false, true, 'everyone', true],
  ['open', 'A', true, false, true, true, null, true, false, true, null, 'everyone', true],
  ['open', 'A', true, true, true, true, true, true, false, true, true, 'everyone', true],
  ['open', 'B', false, false, true, true, null, true, false, false, null, 'everyone', true],
  ['open', 'B', false, true, true, true, true, true, false, false, true, 'everyone', true],
  ['open', 'B', true, false, true, true, null, true, false, true, null, 'everyone', true],
  ['open', 'B', true, true, true, true, true, true, false, true, true, 'everyone', true],
  // « En vocal » : l'écriture du propriétaire dépend de sa présence, non simulée ici.
  ['inVoice', 'A', false, false, false, null, null, false, true, false, null, 'inVoice', true],
  ['inVoice', 'A', false, true, false, null, true, false, true, false, true, 'inVoice', true],
  ['inVoice', 'B', false, false, false, null, null, false, true, false, null, 'inVoice', true],
  ['inVoice', 'B', false, true, false, null, true, false, true, false, true, 'inVoice', true],
  ['locked', 'A', false, false, false, true, null, false, true, true, null, 'ownerOnly', true],
  ['locked', 'A', false, true, false, true, true, false, true, true, true, 'ownerOnly', true],
  ['locked', 'B', false, false, false, true, null, false, true, true, null, 'ownerOnly', true],
  ['locked', 'B', false, true, false, true, true, false, true, true, true, 'ownerOnly', true],
  ['nobody', 'A', false, false, false, false, null, false, true, false, null, 'nobody', true],
  ['nobody', 'A', false, true, false, false, false, false, true, false, false, 'nobody', true],
  ['nobody', 'A', true, false, false, false, null, false, true, false, null, 'nobody', true],
  ['nobody', 'A', true, true, false, false, false, false, true, false, false, 'nobody', true],
  ['nobody', 'B', false, false, false, false, null, false, true, false, null, 'nobody', true],
  ['nobody', 'B', false, true, false, false, false, false, true, false, false, 'nobody', true],
  ['nobody', 'B', true, false, false, false, null, false, true, false, null, 'nobody', true],
  ['nobody', 'B', true, true, false, false, false, false, true, false, false, 'nobody', true],
];

describe('matrice d\'écriture des vocaux temporaires', () => {
  test('la table couvre 28 combinaisons distinctes', () => {
    expect(CAS).toHaveLength(28);
    expect(new Set(CAS.map((c) => c.slice(0, 4).join('|'))).size).toBe(28);
  });

  test.each(CAS)(
    '%s · catégorie %s · verrou %s · rôle d\'office %s',
    (textChat, cat, lock, role, tous, proprio, roleEcrit, evAllow, evDeny, propAllow, roleAllow, panneau, bot) => {
      const ow = construire(textChat, cat, lock, role);
      const ev = ow.find((o) => o.id === EVERYONE);
      const prop = ow.find((o) => o.id === OWNER);
      const ro = ow.find((o) => o.id === ROLE);

      expect(!!ev && aSend(ev.allow)).toBe(evAllow);
      expect(!!ev && aSend(ev.deny)).toBe(evDeny);
      expect(!!prop && aSend(prop.allow)).toBe(propAllow);
      expect(role ? !!ro && aSend(ro.allow) : null).toBe(roleAllow);

      const effectifTous = peutEcrire(ow, 'inconnu', []);
      expect(effectifTous).toBe(tous);
      if (proprio !== null) expect(peutEcrire(ow, OWNER, [])).toBe(proprio);
      if (role) expect(peutEcrire(ow, 'membre-du-role', [ROLE])).toBe(roleEcrit as boolean);

      expect(modePanneau(textChat, ow, effectifTous)).toBe(panneau);

      // Le bot doit pouvoir écrire là où il pose des surcharges
      const policy = { ...defaultTempVoicePolicy(), textChat, lockOnCreate: lock, autoAllowRoleIds: role ? [ROLE] : [] };
      expect(requiredBotPermissions(policy).includes(SEND)).toBe(bot);
    },
  );
});

describe('aller-retour réglage du dashboard → salon → panneau', () => {
  const libelle = (mode: string) => libelleModeEcriture(mode as 'everyone', 'fr').libelle;

  test.each([
    ['open', 'Tout le monde'],
    ['inVoice', 'Ceux qui sont en vocal'],
    ['locked', 'Moi seul'],
    ['nobody', 'Personne'],
  ] as const)('%s s\'affiche « %s »', (reglage, attendu) => {
    const textChat = normalizeTempVoicePolicy({ textChat: reglage }).textChat;
    expect(textChat).toBe(reglage);
    const ow = construire(textChat, 'A', false, false);
    expect(libelle(modePanneau(textChat, ow, peutEcrire(ow, 'inconnu', [])))).toBe(attendu);
  });

  test.each([
    ['A', 'Tout le monde'],
    ['B', 'Personne'],
  ] as const)('inherit en catégorie %s : option « Hérité » et état réel « %s »', (cat, attendu) => {
    const textChat = normalizeTempVoicePolicy({ textChat: 'inherit' }).textChat;
    const ow = construire(textChat, cat, false, false);
    expect(modeEcritureDepuisTextChat(textChat)).toBeNull();
    expect(m.panel_tempvoice_mode_inherit_label({}, { locale: 'fr' })).toContain('Hérité');
    expect(libelle(modePanneau(textChat, ow, peutEcrire(ow, 'inconnu', [])))).toBe(attendu);
  });

  test('les cinq réglages sont parcourus', () => {
    expect(TEMP_VOICE_TEXT_CHAT_MODES).toHaveLength(5);
  });
});
