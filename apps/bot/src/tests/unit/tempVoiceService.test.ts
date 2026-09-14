import { describe, expect, test } from 'bun:test';
import { OverwriteType, PermissionFlagsBits } from 'discord.js';
import {
  buildCreationOverwrites,
  CHANNEL_PATCHES,
  defaultTempVoicePolicy,
  LEGACY_OWNER_POWERS,
  MAX_ADDITIONAL_GENERATORS,
  MAX_AUTO_ALLOW_ROLES,
  normalizeTempVoiceGeneratorsInput,
  normalizeTempVoicePolicy,
  ownerAllowBits,
  ownerPermissionPatch,
  ownerPowersFromBits,
  ownerRevokedPermissions,
  renderChannelName,
  resolveTempVoiceGenerators,
  toOverwriteDrafts,
  type OverwriteDraft,
  type TempVoiceGuildConfig,
} from '../../services/features/tempVoiceService.js';

/**
 * Le module des vocaux temporaires n'avait aucun test, et c'est precisement son
 * calcul de permissions qui decide si un salon reste ferme sur un serveur
 * ferme. Les cas verifies ici sont ceux ou une erreur ne se voit pas : une
 * surcharge heritee ecrasee, un refus transforme en autorisation, un reglage
 * absent lu comme « rien ».
 */

const EVERYONE = '100000000000000000';
const OWNER = '200000000000000000';
const ROLE_VIP = '300000000000000000';
const ROLE_AUTRE = '400000000000000000';

function findOverwrite(overwrites: ReturnType<typeof buildCreationOverwrites>, id: string) {
  return overwrites.find((overwrite) => overwrite.id === id);
}

function allowOf(overwrites: ReturnType<typeof buildCreationOverwrites>, id: string): bigint {
  return BigInt((findOverwrite(overwrites, id)?.allow ?? 0n) as bigint);
}

function denyOf(overwrites: ReturnType<typeof buildCreationOverwrites>, id: string): bigint {
  return BigInt((findOverwrite(overwrites, id)?.deny ?? 0n) as bigint);
}

function has(bits: bigint, flag: bigint): boolean {
  return (bits & flag) === flag;
}

describe('normalizeTempVoicePolicy', () => {
  test('une configuration absente rend le comportement historique', () => {
    // Les serveurs configures avant ce reglage n'ont rien en base. Leur rendre
    // autre chose que l'ancien comportement changerait leurs salons sans que
    // personne n'ait rien demande.
    const policy = normalizeTempVoicePolicy(undefined);

    expect(policy).toEqual(defaultTempVoicePolicy());
    expect(policy.ownerPowers).toEqual([...LEGACY_OWNER_POWERS]);
    expect(policy.textChat).toBe('inherit');
  });

  test('une liste de pouvoirs vide est respectee, contrairement a une absence', () => {
    // La nuance porte tout le reglage : « je ne veux aucun pouvoir » et « je
    // n'ai jamais touche a ce champ » arrivent tous deux sous forme falsy.
    expect(normalizeTempVoicePolicy({ ownerPowers: [] }).ownerPowers).toEqual([]);
    expect(normalizeTempVoicePolicy({}).ownerPowers).toEqual([...LEGACY_OWNER_POWERS]);
  });

  test('borne la limite de places a ce que Discord accepte', () => {
    expect(normalizeTempVoicePolicy({ userLimit: 5000 }).userLimit).toBe(99);
    expect(normalizeTempVoicePolicy({ userLimit: -3 }).userLimit).toBe(0);
    expect(normalizeTempVoicePolicy({ userLimit: 7.9 }).userLimit).toBe(7);
    expect(normalizeTempVoicePolicy({ userLimit: 'douze' }).userLimit).toBe(0);
  });

  test('ecarte les identifiants de role qui n en sont pas', () => {
    const policy = normalizeTempVoicePolicy({
      autoAllowRoleIds: [ROLE_VIP, 'everyone', '42', null, ROLE_VIP],
    });

    expect(policy.autoAllowRoleIds).toEqual([ROLE_VIP]);
  });

  test('plafonne le nombre de roles autorises d office', () => {
    const trop = Array.from({ length: MAX_AUTO_ALLOW_ROLES + 5 }, (_, i) => String(100000000000000000n + BigInt(i)));

    expect(normalizeTempVoicePolicy({ autoAllowRoleIds: trop }).autoAllowRoleIds).toHaveLength(MAX_AUTO_ALLOW_ROLES);
  });

  test('un mode de chat inconnu retombe sur l heritage', () => {
    expect(normalizeTempVoicePolicy({ textChat: 'members' }).textChat).toBe('inherit');
    expect(normalizeTempVoicePolicy({ textChat: 'locked' }).textChat).toBe('locked');
  });

  test('ecarte un pouvoir invente', () => {
    expect(normalizeTempVoicePolicy({ ownerPowers: ['mute', 'administrator'] }).ownerPowers).toEqual(['mute']);
  });
});

describe('normalizeTempVoiceGeneratorsInput', () => {
  test('ecarte une entree sans salon plutot que de la corriger', () => {
    // La route ecrivait le corps de la requete tel quel : un generateur sans
    // salon s'affichait dans la page comme une ligne active qui ne declenchait
    // jamais rien.
    const generators = normalizeTempVoiceGeneratorsInput([
      { nameTemplate: 'Salon' },
      { channelId: 'pas-un-id' },
      { channelId: ROLE_VIP },
    ]);

    expect(generators).toHaveLength(1);
    expect(generators[0]?.channelId).toBe(ROLE_VIP);
  });

  test('un meme salon generateur n apparait qu une fois', () => {
    const generators = normalizeTempVoiceGeneratorsInput([
      { channelId: ROLE_VIP, nameTemplate: 'Premier' },
      { channelId: ROLE_VIP, nameTemplate: 'Jamais atteint' },
    ]);

    expect(generators).toHaveLength(1);
    expect(generators[0]?.nameTemplate).toBe('Premier');
  });

  test('plafonne la liste', () => {
    const trop = Array.from({ length: MAX_ADDITIONAL_GENERATORS + 10 }, (_, i) => ({
      channelId: String(100000000000000000n + BigInt(i)),
    }));

    expect(normalizeTempVoiceGeneratorsInput(trop)).toHaveLength(MAX_ADDITIONAL_GENERATORS);
  });

  test('normalise la politique de chaque entree', () => {
    const [generator] = normalizeTempVoiceGeneratorsInput([
      { channelId: ROLE_VIP, userLimit: 400, textChat: 'nawak', autoAllowRoleIds: ['x'] },
    ]);

    expect(generator?.userLimit).toBe(99);
    expect(generator?.textChat).toBe('inherit');
    expect(generator?.autoAllowRoleIds).toEqual([]);
  });

  test('un gabarit vide retombe sur le gabarit par defaut', () => {
    const [generator] = normalizeTempVoiceGeneratorsInput([{ channelId: ROLE_VIP, nameTemplate: '   ' }]);

    expect(generator?.nameTemplate).toContain('{user}');
  });
});

describe('resolveTempVoiceGenerators', () => {
  const base: TempVoiceGuildConfig = {
    tempVoiceEnabled: true,
    tempVoiceChannelId: ROLE_VIP,
    tempVoiceCategoryId: null,
    tempVoiceNameTemplate: '🔊 Salon de {user}',
  };

  test('le generateur principal porte la politique par defaut du serveur', () => {
    const [principal] = resolveTempVoiceGenerators({
      ...base,
      tempVoiceDefaults: { userLimit: 6, lockOnCreate: true },
    });

    expect(principal?.policy.userLimit).toBe(6);
    expect(principal?.policy.lockOnCreate).toBe(true);
  });

  test('un generateur additionnel garde sa propre politique', () => {
    const generators = resolveTempVoiceGenerators({
      ...base,
      tempVoiceDefaults: { userLimit: 6 },
      tempVoiceGenerators: [{ channelId: ROLE_AUTRE, userLimit: 2, textChat: 'open' }],
    });

    expect(generators).toHaveLength(2);
    expect(generators[0]?.policy.userLimit).toBe(6);
    expect(generators[1]?.policy.userLimit).toBe(2);
    expect(generators[1]?.policy.textChat).toBe('open');
  });

  test('un serveur sans generateur principal ne rend que les additionnels', () => {
    const generators = resolveTempVoiceGenerators({
      ...base,
      tempVoiceChannelId: null,
      tempVoiceGenerators: [{ channelId: ROLE_AUTRE }],
    });

    expect(generators).toHaveLength(1);
    expect(generators[0]?.channelId).toBe(ROLE_AUTRE);
  });
});

describe('ownerAllowBits', () => {
  test('le proprietaire voit, entre et parle quels que soient ses pouvoirs', () => {
    const bits = ownerAllowBits({ ...defaultTempVoicePolicy(), ownerPowers: [] });

    expect(bits).toContain(PermissionFlagsBits.ViewChannel);
    expect(bits).toContain(PermissionFlagsBits.Connect);
    expect(bits).toContain(PermissionFlagsBits.Speak);
    expect(bits).not.toContain(PermissionFlagsBits.MuteMembers);
  });

  test('chaque pouvoir coche ajoute son droit', () => {
    const bits = ownerAllowBits({
      ...defaultTempVoicePolicy(),
      ownerPowers: ['manageChannel', 'manageMessages'],
    });

    expect(bits).toContain(PermissionFlagsBits.ManageChannels);
    expect(bits).toContain(PermissionFlagsBits.ManageMessages);
  });

  test('le droit d ecrire n est pose que lorsque le chat est ferme', () => {
    // En mode herite, poser un droit explicite couperait le proprietaire de sa
    // categorie - exactement ce que le module evite partout ailleurs.
    expect(ownerAllowBits({ ...defaultTempVoicePolicy(), textChat: 'inherit' }))
      .not.toContain(PermissionFlagsBits.SendMessages);
    expect(ownerAllowBits({ ...defaultTempVoicePolicy(), textChat: 'locked' }))
      .toContain(PermissionFlagsBits.SendMessages);
  });
});

describe('buildCreationOverwrites', () => {
  const heritageFerme: OverwriteDraft[] = [
    {
      id: EVERYONE,
      type: OverwriteType.Role,
      allow: 0n,
      deny: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect,
    },
  ];

  test('conserve le refus herite de la categorie', () => {
    // Le coeur du module : un salon temporaire qui se rouvrirait a @everyone
    // serait, sur un serveur ferme, le seul salon visible des non-membres.
    const overwrites = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: heritageFerme,
      policy: defaultTempVoicePolicy(),
    });

    expect(has(denyOf(overwrites, EVERYONE), PermissionFlagsBits.ViewChannel)).toBe(true);
    expect(has(denyOf(overwrites, EVERYONE), PermissionFlagsBits.Connect)).toBe(true);
  });

  test('ouvrir le chat n ouvre pas l acces au salon', () => {
    const overwrites = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: heritageFerme,
      policy: { ...defaultTempVoicePolicy(), textChat: 'open' },
    });

    expect(has(allowOf(overwrites, EVERYONE), PermissionFlagsBits.SendMessages)).toBe(true);
    // La visibilite et la connexion restent celles de la categorie.
    expect(has(denyOf(overwrites, EVERYONE), PermissionFlagsBits.ViewChannel)).toBe(true);
    expect(has(denyOf(overwrites, EVERYONE), PermissionFlagsBits.Connect)).toBe(true);
  });

  test('le proprietaire recoit ses droits sans perdre ce que la categorie lui donnait', () => {
    const overwrites = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: [
        ...heritageFerme,
        { id: OWNER, type: OverwriteType.Member, allow: PermissionFlagsBits.PrioritySpeaker, deny: 0n },
      ],
      policy: defaultTempVoicePolicy(),
    });

    expect(has(allowOf(overwrites, OWNER), PermissionFlagsBits.PrioritySpeaker)).toBe(true);
    expect(has(allowOf(overwrites, OWNER), PermissionFlagsBits.Connect)).toBe(true);
    expect(has(allowOf(overwrites, OWNER), PermissionFlagsBits.MuteMembers)).toBe(true);
  });

  test('un droit autorise cesse d etre refuse', () => {
    // Discord traite `allow` et `deny` comme exclusifs. Les laisser diverger
    // produit une surcharge que l'interface affiche et que la passerelle
    // ignore : le reglage parait pose alors qu'il ne s'applique pas.
    const overwrites = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: [{ id: OWNER, type: OverwriteType.Member, allow: 0n, deny: PermissionFlagsBits.Connect }],
      policy: defaultTempVoicePolicy(),
    });

    expect(has(allowOf(overwrites, OWNER), PermissionFlagsBits.Connect)).toBe(true);
    expect(has(denyOf(overwrites, OWNER), PermissionFlagsBits.Connect)).toBe(false);
  });

  test('les roles autorises d office entrent malgre un salon cree verrouille', () => {
    const overwrites = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: [],
      policy: { ...defaultTempVoicePolicy(), lockOnCreate: true, autoAllowRoleIds: [ROLE_VIP] },
    });

    expect(has(denyOf(overwrites, EVERYONE), PermissionFlagsBits.Connect)).toBe(true);
    expect(has(allowOf(overwrites, ROLE_VIP), PermissionFlagsBits.Connect)).toBe(true);
    expect(has(allowOf(overwrites, ROLE_VIP), PermissionFlagsBits.ViewChannel)).toBe(true);
  });

  test('le chat ferme laisse ecrire le proprietaire et les roles autorises', () => {
    const overwrites = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: [],
      policy: { ...defaultTempVoicePolicy(), textChat: 'locked', autoAllowRoleIds: [ROLE_VIP] },
    });

    expect(has(denyOf(overwrites, EVERYONE), PermissionFlagsBits.SendMessages)).toBe(true);
    expect(has(allowOf(overwrites, OWNER), PermissionFlagsBits.SendMessages)).toBe(true);
    expect(has(allowOf(overwrites, ROLE_VIP), PermissionFlagsBits.SendMessages)).toBe(true);
  });

  test('un role autorise ne prend pas la place du proprietaire', () => {
    // Le proprietaire est un membre, le role en est un autre, mais un serveur
    // peut coller le meme identifiant dans les deux champs par accident.
    const overwrites = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: [],
      policy: { ...defaultTempVoicePolicy(), autoAllowRoleIds: [OWNER] },
    });

    expect(has(allowOf(overwrites, OWNER), PermissionFlagsBits.MuteMembers)).toBe(true);
    expect(findOverwrite(overwrites, OWNER)?.type).toBe(OverwriteType.Member);
  });

  test('ne pose aucune surcharge @everyone quand la politique n en demande pas', () => {
    // Sans heritage ni reglage, le salon doit rester parfaitement synchronise
    // avec sa categorie : une surcharge vide se verrait dans l'interface et
    // laisserait croire a un reglage.
    const overwrites = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: [],
      policy: defaultTempVoicePolicy(),
    });

    expect(findOverwrite(overwrites, EVERYONE)).toBeUndefined();
    expect(overwrites).toHaveLength(1);
  });
});

describe('CHANNEL_PATCHES', () => {
  /**
   * Regression gardee nommement : « Déverrouiller » posait `Connect: true` sur
   * @everyone, et la levee de reservation faisait de meme. Sur un serveur dont
   * la categorie refuse la connexion aux membres non verifies, un clic sur ce
   * bouton ouvrait le salon a tout le serveur - le salon temporaire devenait le
   * seul ou entrer sans avoir passe la verification.
   *
   * `null` rend le droit a la categorie ; `true` l'ecrase. La nuance ne se voit
   * pas a la lecture du code appelant, d'ou ces assertions.
   */
  test('rien de ce qui rouvre un salon n autorise explicitement', () => {
    expect(CHANNEL_PATCHES.unlock.Connect).toBeNull();
    expect(CHANNEL_PATCHES.clearReservation.Connect).toBeNull();
    expect(CHANNEL_PATCHES.openChat.SendMessages).toBeNull();

    for (const patch of Object.values(CHANNEL_PATCHES)) {
      for (const [permission, value] of Object.entries(patch)) {
        expect(
          value === true,
          `${permission} ne doit jamais être autorisé explicitement : utiliser null pour rendre le droit à la catégorie`,
        ).toBe(false);
      }
    }
  });

  test('verrouiller ne touche qu a la connexion', () => {
    // La visibilite du salon n'est jamais modifiee par le panneau : un salon
    // verrouille reste lisible par ceux qui le voyaient deja.
    expect(CHANNEL_PATCHES.lock).toEqual({ Connect: false });
  });

  test('bannir coupe aussi le chat ecrit', () => {
    // Le bannissement ne coupait que la connexion : le banni continuait de lire
    // et d'ecrire dans le chat du salon dont on venait de le sortir.
    expect(CHANNEL_PATCHES.ban.Connect).toBe(false);
    expect(CHANNEL_PATCHES.ban.ViewChannel).toBe(false);
    expect(CHANNEL_PATCHES.ban.SendMessages).toBe(false);
  });
});

describe('ownerPowersFromBits / ownerPermissionPatch', () => {
  test('relit les pouvoirs reellement poses sur un salon', () => {
    const allow = PermissionFlagsBits.Connect | PermissionFlagsBits.MoveMembers | PermissionFlagsBits.ManageMessages;

    expect(ownerPowersFromBits(allow)).toEqual(['move', 'manageMessages']);
  });

  test('un transfert reconduit les pouvoirs de l ancien proprietaire', () => {
    // Le salon ne retient pas quel generateur l'a cree, et la politique a pu
    // changer depuis : ce que le salon porte est la seule source fiable.
    const patch = ownerPermissionPatch(ownerPowersFromBits(PermissionFlagsBits.MuteMembers));

    expect(patch.MuteMembers).toBe(true);
    expect(patch.Connect).toBe(true);
    // Un pouvoir non accorde vaut `null` et non `false` : le refuser couperait
    // le membre de ce que ses roles lui donnent ailleurs sur le serveur.
    expect(patch.MoveMembers).toBeNull();
    expect(patch.ManageChannels).toBeNull();
  });

  test('rend au proprietaire sortant tout ce qu un transfert doit reprendre', () => {
    // L'ancien proprietaire gardait ses pouvoirs de moderation vocale sur un
    // salon qui n'etait plus le sien.
    const revoked = ownerRevokedPermissions();

    expect(Object.values(revoked).every((value) => value === null)).toBe(true);
    expect(Object.keys(revoked)).toContain('MuteMembers');
    expect(Object.keys(revoked)).toContain('SendMessages');
  });
});

describe('toOverwriteDrafts', () => {
  test('accepte les champs de bits de discord.js comme des entiers', () => {
    const drafts = toOverwriteDrafts([
      { id: EVERYONE, type: OverwriteType.Role, allow: { bitfield: PermissionFlagsBits.Connect }, deny: 0n },
    ]);

    expect(drafts[0]?.allow).toBe(PermissionFlagsBits.Connect);
  });
});

describe('renderChannelName', () => {
  test('remplace le pseudo et coupe a la longueur acceptee', () => {
    expect(renderChannelName('🔊 Salon de {user}', 'Alex')).toBe('🔊 Salon de Alex');
    expect(renderChannelName('{user}', 'x'.repeat(200))).toHaveLength(100);
  });

  test('ne rend jamais un nom vide', () => {
    // Discord refuse un nom vide : le salon ne serait pas cree, et le membre
    // resterait bloque dans le generateur sans explication.
    expect(renderChannelName('{user}', '   ').length).toBeGreaterThan(0);
  });
});
