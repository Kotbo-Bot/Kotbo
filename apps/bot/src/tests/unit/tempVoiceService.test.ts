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
  ownerChatPatch,
  ownerPermissionPatch,
  ownerPowersFromBits,
  ownerRevokedPermissions,
  requiredBotPermissions,
  resolveReservationRoleId,
  restoreFromCategory,
  trustPermissionPatch,
  categoryTrustPatch,
  TRUST_BIT_COUNT,
  renderChannelName,
  resolveTempVoiceGenerators,
  toOverwriteDrafts,
  type OverwriteDraft,
  type TempVoiceGuildConfig,
} from '../../services/features/tempVoiceService.js';

/**
 * Le module des vocaux temporaires n'avait aucun test, et c'est précisément son
 * calcul de permissions qui décide si un salon reste fermé sur un serveur
 * fermé. Les cas vérifiés ici sont ceux où une erreur ne se voit pas : une
 * surcharge héritée écrasée, un refus transformé en autorisation, un réglage
 * absent lu comme « rien ».
 */

const EVERYONE = '100000000000000000';
const OWNER = '200000000000000000';
const VIP_ROLE = '300000000000000000';
const OTHER_ROLE = '400000000000000000';

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
    // Les serveurs configures avant ce réglage n'ont rien en base. Leur rendre
    // autre chose que l'ancien comportement changerait leurs salons sans que
    // personne n'ait rien demande.
    const policy = normalizeTempVoicePolicy(undefined);

    expect(policy).toEqual(defaultTempVoicePolicy());
    expect(policy.ownerPowers).toEqual([...LEGACY_OWNER_POWERS]);
    expect(policy.textChat).toBe('inherit');
  });

  test('une liste de pouvoirs vide est respectée, contrairement à une absence', () => {
    // La nuance porte tout le réglage : « je ne veux aucun pouvoir » et « je
    // n'ai jamais touché à ce champ » arrivent tous deux sous forme falsy.
    expect(normalizeTempVoicePolicy({ ownerPowers: [] }).ownerPowers).toEqual([]);
    expect(normalizeTempVoicePolicy({}).ownerPowers).toEqual([...LEGACY_OWNER_POWERS]);
  });

  test('borne la limite de places à ce que Discord accepte', () => {
    expect(normalizeTempVoicePolicy({ userLimit: 5000 }).userLimit).toBe(99);
    expect(normalizeTempVoicePolicy({ userLimit: -3 }).userLimit).toBe(0);
    expect(normalizeTempVoicePolicy({ userLimit: 7.9 }).userLimit).toBe(7);
    expect(normalizeTempVoicePolicy({ userLimit: 'douze' }).userLimit).toBe(0);
  });

  test('écarte les identifiants de rôle qui n\'en sont pas', () => {
    const policy = normalizeTempVoicePolicy({
      autoAllowRoleIds: [VIP_ROLE, 'everyone', '42', null, VIP_ROLE],
    });

    expect(policy.autoAllowRoleIds).toEqual([VIP_ROLE]);
  });

  test('plafonne le nombre de rôles autorisés d\'office', () => {
    const tooMany = Array.from({ length: MAX_AUTO_ALLOW_ROLES + 5 }, (_, i) => String(100000000000000000n + BigInt(i)));

    expect(normalizeTempVoicePolicy({ autoAllowRoleIds: tooMany }).autoAllowRoleIds).toHaveLength(MAX_AUTO_ALLOW_ROLES);
  });

  test('un mode de chat inconnu retombe sur l\'héritage', () => {
    expect(normalizeTempVoicePolicy({ textChat: 'members' }).textChat).toBe('inherit');
    expect(normalizeTempVoicePolicy({ textChat: 'locked' }).textChat).toBe('locked');
  });

  test('écarte un pouvoir inventé', () => {
    expect(normalizeTempVoicePolicy({ ownerPowers: ['mute', 'administrator'] }).ownerPowers).toEqual(['mute']);
  });
});

describe('normalizeTempVoiceGeneratorsInput', () => {
  test('écarte une entrée sans salon plutôt que de la corriger', () => {
    // La route ecrivait le corps de la requête tel quel : un générateur sans
    // salon s'affichait dans la page comme une ligne active qui ne déclenchait
    // jamais rien.
    const generators = normalizeTempVoiceGeneratorsInput([
      { nameTemplate: 'Salon' },
      { channelId: 'pas-un-id' },
      { channelId: VIP_ROLE },
    ]);

    expect(generators).toHaveLength(1);
    expect(generators[0]?.channelId).toBe(VIP_ROLE);
  });

  test('un même salon générateur n\'apparaît qu\'une fois', () => {
    const generators = normalizeTempVoiceGeneratorsInput([
      { channelId: VIP_ROLE, nameTemplate: 'Premier' },
      { channelId: VIP_ROLE, nameTemplate: 'Jamais atteint' },
    ]);

    expect(generators).toHaveLength(1);
    expect(generators[0]?.nameTemplate).toBe('Premier');
  });

  test('n\'accepte que des tableaux', () => {
    // Le JSON vient de la base : un objet, une chaîne ou `null` y traînent dès
    // qu'une version antérieure - ou une écriture à la main - l'a déposé.
    expect(normalizeTempVoiceGeneratorsInput({ channelId: VIP_ROLE })).toEqual([]);
    expect(normalizeTempVoiceGeneratorsInput('texte')).toEqual([]);
    expect(normalizeTempVoiceGeneratorsInput(null)).toEqual([]);
  });

  test('conserve les champs d\'une entrée valide', () => {
    // Même exigence qu'à la résolution, mais à l'écriture : la page envoie ces
    // quatre champs, la base doit les garder.
    expect(normalizeTempVoiceGeneratorsInput([{
      channelId: VIP_ROLE,
      categoryId: OWNER,
      nameTemplate: '🎮 {user}',
      requiredRoleId: OTHER_ROLE,
    }])).toEqual([expect.objectContaining({
      channelId: VIP_ROLE,
      categoryId: OWNER,
      nameTemplate: '🎮 {user}',
      requiredRoleId: OTHER_ROLE,
    })]);
  });

  test('plafonne la liste', () => {
    const tooMany = Array.from({ length: MAX_ADDITIONAL_GENERATORS + 10 }, (_, i) => ({
      channelId: String(100000000000000000n + BigInt(i)),
    }));

    expect(normalizeTempVoiceGeneratorsInput(tooMany)).toHaveLength(MAX_ADDITIONAL_GENERATORS);
  });

  test('écarte un générateur posé sur le salon du principal', () => {
    // La resolution place le principal en tête et s'arrête au premier salon qui
    // correspond : un additionnel sur le même salon ne serait jamais atteint,
    // et la page afficherait pourtant deux générateurs distincts.
    const entries = [{ channelId: VIP_ROLE }, { channelId: OTHER_ROLE }];

    expect(normalizeTempVoiceGeneratorsInput(entries, undefined, VIP_ROLE))
      .toEqual([expect.objectContaining({ channelId: OTHER_ROLE })]);
  });

  test('normalise la politique de chaque entrée', () => {
    const [generator] = normalizeTempVoiceGeneratorsInput([
      { channelId: VIP_ROLE, userLimit: 400, textChat: 'nawak', autoAllowRoleIds: ['x'] },
    ]);

    expect(generator?.userLimit).toBe(99);
    expect(generator?.textChat).toBe('inherit');
    expect(generator?.autoAllowRoleIds).toEqual([]);
  });

  test('un gabarit vide retombe sur le gabarit par défaut', () => {
    const [generator] = normalizeTempVoiceGeneratorsInput([{ channelId: VIP_ROLE, nameTemplate: '   ' }]);

    expect(generator?.nameTemplate).toContain('{user}');
  });
});

describe('resolveTempVoiceGenerators', () => {
  const base: TempVoiceGuildConfig = {
    tempVoiceEnabled: true,
    tempVoiceChannelId: VIP_ROLE,
    tempVoiceCategoryId: null,
    tempVoiceNameTemplate: '🔊 Salon de {user}',
  };

  test('le générateur principal porte la politique par défaut du serveur', () => {
    const [principal] = resolveTempVoiceGenerators({
      ...base,
      tempVoiceDefaults: { userLimit: 6, lockOnCreate: true },
    });

    expect(principal?.policy.userLimit).toBe(6);
    expect(principal?.policy.lockOnCreate).toBe(true);
  });

  test('un générateur additionnel garde sa propre politique', () => {
    const generators = resolveTempVoiceGenerators({
      ...base,
      tempVoiceDefaults: { userLimit: 6 },
      tempVoiceGenerators: [{ channelId: OTHER_ROLE, userLimit: 2, textChat: 'open' }],
    });

    expect(generators).toHaveLength(2);
    expect(generators[0]?.policy.userLimit).toBe(6);
    expect(generators[1]?.policy.userLimit).toBe(2);
    expect(generators[1]?.policy.textChat).toBe('open');
  });

  test('un générateur additionnel garde son salon, sa catégorie, son gabarit et son rôle requis', () => {
    // Quatre champs distincts que rien n'exigeait : perdre l'un d'eux fait
    // naître les salons au mauvais endroit, sous le mauvais nom, ou ouvre un
    // générateur réservé.
    const [, additionnel] = resolveTempVoiceGenerators({
      ...base,
      tempVoiceChannelId: VIP_ROLE,
      tempVoiceGenerators: [{
        channelId: OTHER_ROLE,
        categoryId: OWNER,
        nameTemplate: '🎮 {user}',
        requiredRoleId: EVERYONE,
      }],
    });

    expect(additionnel?.channelId).toBe(OTHER_ROLE);
    expect(additionnel?.categoryId).toBe(OWNER);
    expect(additionnel?.nameTemplate).toBe('🎮 {user}');
    expect(additionnel?.requiredRoleId).toBe(EVERYONE);
    expect(additionnel?.primary).toBe(false);
  });

  test('un serveur sans générateur principal ne rend que les additionnels', () => {
    const generators = resolveTempVoiceGenerators({
      ...base,
      tempVoiceChannelId: null,
      tempVoiceGenerators: [{ channelId: OTHER_ROLE }],
    });

    expect(generators).toHaveLength(1);
    expect(generators[0]?.channelId).toBe(OTHER_ROLE);
  });
});

describe('ownerAllowBits', () => {
  test('le propriétaire voit, entre et parle quels que soient ses pouvoirs', () => {
    const bits = ownerAllowBits({ ...defaultTempVoicePolicy(), ownerPowers: [] });

    expect(bits).toContain(PermissionFlagsBits.ViewChannel);
    expect(bits).toContain(PermissionFlagsBits.Connect);
    expect(bits).toContain(PermissionFlagsBits.Speak);
    expect(bits).not.toContain(PermissionFlagsBits.MuteMembers);
  });

  test('chaque pouvoir coché ajoute son droit', () => {
    const bits = ownerAllowBits({
      ...defaultTempVoicePolicy(),
      ownerPowers: ['manageChannel', 'manageMessages'],
    });

    expect(bits).toContain(PermissionFlagsBits.ManageChannels);
    expect(bits).toContain(PermissionFlagsBits.ManageMessages);
  });

  test('le propriétaire lit toujours, et écrit quand le chat lui serait fermé', () => {
    // Verrouiller ferme l'écriture à @everyone : sans ce bit, appuyer sur
    // « Verrouiller » rendrait le propriétaire muet chez lui. La confrontation
    // avec la catégorie reste faite par `grantableBits`, pas ici.
    for (const textChat of ['inherit', 'open', 'locked'] as const) {
      const bits = ownerAllowBits({ ...defaultTempVoicePolicy(), textChat });
      expect(bits).toContain(PermissionFlagsBits.ReadMessageHistory);
    }

    expect(ownerAllowBits({ ...defaultTempVoicePolicy(), textChat: 'locked' }))
      .toContain(PermissionFlagsBits.SendMessages);
    expect(ownerAllowBits({ ...defaultTempVoicePolicy(), lockOnCreate: true }))
      .toContain(PermissionFlagsBits.SendMessages);

    // Hors de ces cas, aucune surcharge nommée : sinon une surcharge de membre primerait
    // sur le rôle et le propriétaire serait le SEUL à écrire dans le chat de son salon.
    expect(ownerAllowBits({ ...defaultTempVoicePolicy(), textChat: 'inherit' }))
      .not.toContain(PermissionFlagsBits.SendMessages);
    expect(ownerAllowBits({ ...defaultTempVoicePolicy(), textChat: 'open' }))
      .not.toContain(PermissionFlagsBits.SendMessages);
  });
});

describe('buildCreationOverwrites', () => {
  const closedInheritance: OverwriteDraft[] = [
    {
      id: EVERYONE,
      type: OverwriteType.Role,
      allow: 0n,
      deny: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect,
    },
  ];

  test('conserve le refus hérité de la catégorie', () => {
    // Le cœur du module : un salon temporaire qui se rouvrirait à @everyone
    // serait, sur un serveur fermé, le seul salon visible des non-membres.
    const overwrites = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: closedInheritance,
      policy: defaultTempVoicePolicy(),
    });

    expect(has(denyOf(overwrites, EVERYONE), PermissionFlagsBits.ViewChannel)).toBe(true);
    expect(has(denyOf(overwrites, EVERYONE), PermissionFlagsBits.Connect)).toBe(true);
  });

  test('en « inherit », le chat n\'est pas réservé au propriétaire', () => {
    // Régression : `ownerAllowBits` accordait SendMessages d'office. Une surcharge de
    // membre primant sur celle d'un rôle, le propriétaire écrivait là où tout le monde
    // héritait du refus de la catégorie — il était seul à parler dans son propre salon.
    const categorieSansChat: OverwriteDraft[] = [
      {
        id: EVERYONE,
        type: OverwriteType.Role,
        allow: 0n,
        deny: PermissionFlagsBits.SendMessages,
      },
    ];

    const overwrites = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: categorieSansChat,
      policy: defaultTempVoicePolicy(),
    });

    // Personne n'est privilégié : le propriétaire suit la catégorie comme les autres.
    expect(has(allowOf(overwrites, OWNER), PermissionFlagsBits.SendMessages)).toBe(false);
    expect(has(allowOf(overwrites, EVERYONE), PermissionFlagsBits.SendMessages)).toBe(false);
  });

  test('un salon verrouillé garde le chat pour le seul propriétaire', () => {
    const overwrites = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: [],
      policy: { ...defaultTempVoicePolicy(), lockOnCreate: true },
    });

    expect(has(allowOf(overwrites, OWNER), PermissionFlagsBits.SendMessages)).toBe(true);
    expect(has(denyOf(overwrites, EVERYONE), PermissionFlagsBits.SendMessages)).toBe(true);
    expect(has(allowOf(overwrites, EVERYONE), PermissionFlagsBits.SendMessages)).toBe(false);
  });

  test('ouvrir le chat n\'ouvre pas l\'accès au salon', () => {
    const overwrites = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: closedInheritance,
      policy: { ...defaultTempVoicePolicy(), textChat: 'open' },
    });

    expect(has(allowOf(overwrites, EVERYONE), PermissionFlagsBits.SendMessages)).toBe(true);
    // La visibilité et la connexion restent celles de la catégorie.
    expect(has(denyOf(overwrites, EVERYONE), PermissionFlagsBits.ViewChannel)).toBe(true);
    expect(has(denyOf(overwrites, EVERYONE), PermissionFlagsBits.Connect)).toBe(true);
  });

  test('le propriétaire reçoit ses droits sans perdre ce que la catégorie lui donnait', () => {
    const overwrites = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: [
        ...closedInheritance,
        { id: OWNER, type: OverwriteType.Member, allow: PermissionFlagsBits.PrioritySpeaker, deny: 0n },
      ],
      policy: defaultTempVoicePolicy(),
    });

    expect(has(allowOf(overwrites, OWNER), PermissionFlagsBits.PrioritySpeaker)).toBe(true);
    expect(has(allowOf(overwrites, OWNER), PermissionFlagsBits.Connect)).toBe(true);
    expect(has(allowOf(overwrites, OWNER), PermissionFlagsBits.MuteMembers)).toBe(true);
  });

  test('un refus nominatif hérité de la catégorie n\'est jamais retourné', () => {
    // Un membre que la catégorie refuse nommément ne doit pas récupérer ce
    // droit en devenant propriétaire d'un salon temporaire : il entrerait dans
    // une catégorie dont il est exclu.
    const overwrites = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: [{
        id: OWNER,
        type: OverwriteType.Member,
        allow: 0n,
        deny: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect,
      }],
      policy: defaultTempVoicePolicy(),
    });

    expect(has(allowOf(overwrites, OWNER), PermissionFlagsBits.Connect)).toBeFalse();
    expect(has(denyOf(overwrites, OWNER), PermissionFlagsBits.Connect)).toBeTrue();
    expect(has(allowOf(overwrites, OWNER), PermissionFlagsBits.ViewChannel)).toBeFalse();
    // Le filtrage porte bit à bit : ce que la catégorie ne refuse pas reste
    // accordé. Sans cette assertion, un « si la cible porte le moindre refus,
    // je n'accorde rien » passerait aussi.
    expect(has(allowOf(overwrites, OWNER), PermissionFlagsBits.Speak)).toBeTrue();
    expect(has(allowOf(overwrites, OWNER), PermissionFlagsBits.MuteMembers)).toBeTrue();
  });

  test('un rôle autorisé d\'office ne reçoit pas ce que la catégorie lui refuse', () => {
    // Même règle pour l'étape des rôles : le chemin était corrigé, rien ne le
    // gardait.
    const overwrites = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: [{
        id: VIP_ROLE,
        type: OverwriteType.Role,
        allow: 0n,
        deny: PermissionFlagsBits.ViewChannel,
      }],
      policy: { ...defaultTempVoicePolicy(), autoAllowRoleIds: [VIP_ROLE] },
    });

    expect(has(allowOf(overwrites, VIP_ROLE), PermissionFlagsBits.ViewChannel)).toBeFalse();
    expect(has(denyOf(overwrites, VIP_ROLE), PermissionFlagsBits.ViewChannel)).toBeTrue();
    expect(has(allowOf(overwrites, VIP_ROLE), PermissionFlagsBits.Connect)).toBeTrue();
  });

  test('ouvrir le chat ne rouvre pas ce que la catégorie refuse à @everyone', () => {
    // L'étape @everyone ne passait pas par le filtre : un refus d'écriture posé
    // par la catégorie était effacé par le mode « ouvert ».
    const overwrites = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: [{
        id: EVERYONE,
        type: OverwriteType.Role,
        allow: 0n,
        deny: PermissionFlagsBits.SendMessages,
      }],
      policy: { ...defaultTempVoicePolicy(), textChat: 'open' },
    });

    expect(has(allowOf(overwrites, EVERYONE), PermissionFlagsBits.SendMessages)).toBeFalse();
    expect(has(denyOf(overwrites, EVERYONE), PermissionFlagsBits.SendMessages)).toBeTrue();
  });

  test('un refus porté par @everyone reste dépassable par le propriétaire', () => {
    // La nuance qui fait tenir le module : sur un serveur fermé, le
    // propriétaire doit entrer dans son propre salon. Une surcharge membre bat
    // une surcharge de rôle côté Discord, et c'est le comportement voulu.
    const overwrites = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: [{
        id: EVERYONE,
        type: OverwriteType.Role,
        allow: 0n,
        deny: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect,
      }],
      policy: defaultTempVoicePolicy(),
    });

    expect(has(allowOf(overwrites, OWNER), PermissionFlagsBits.Connect)).toBeTrue();
    expect(has(denyOf(overwrites, EVERYONE), PermissionFlagsBits.Connect)).toBeTrue();
  });

  test('les rôles autorisés d\'office entrent malgré un salon créé verrouillé', () => {
    const overwrites = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: [],
      policy: { ...defaultTempVoicePolicy(), lockOnCreate: true, autoAllowRoleIds: [VIP_ROLE] },
    });

    expect(has(denyOf(overwrites, EVERYONE), PermissionFlagsBits.Connect)).toBe(true);
    expect(has(allowOf(overwrites, VIP_ROLE), PermissionFlagsBits.Connect)).toBe(true);
    expect(has(allowOf(overwrites, VIP_ROLE), PermissionFlagsBits.ViewChannel)).toBe(true);
  });

  test('le chat fermé laisse écrire le propriétaire et les rôles autorisés', () => {
    const overwrites = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: [],
      policy: { ...defaultTempVoicePolicy(), textChat: 'locked', autoAllowRoleIds: [VIP_ROLE] },
    });

    expect(has(denyOf(overwrites, EVERYONE), PermissionFlagsBits.SendMessages)).toBe(true);
    expect(has(allowOf(overwrites, OWNER), PermissionFlagsBits.SendMessages)).toBe(true);
    expect(has(allowOf(overwrites, VIP_ROLE), PermissionFlagsBits.SendMessages)).toBe(true);
  });

  test('ne pose aucune surcharge @everyone quand la politique n\'en demande pas', () => {
    // Sans héritage ni réglage, le salon doit rester parfaitement synchronise
    // avec sa catégorie : une surcharge vide se verrait dans l'interface et
    // laisserait croire à un réglage.
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
   * Regression gardée nommément : « Déverrouiller » posait `Connect: true` sur
   * @everyone, et la levee de réservation faisait de même. Sur un serveur dont
   * la catégorie refuse la connexion aux membres non vérifiés, un clic sur ce
   * bouton ouvrait le salon à tout le serveur - le salon temporaire devenait le
   * seul où entrer sans avoir passé la vérification.
   *
   * `null` marque un droit à rendre à la catégorie, que `restoreFromCategory`
   * résout ; `true` l'écraserait. La nuance ne se voit pas à la lecture du code
   * appelant, d'où ces assertions.
   */
  test('rouvrir un ACCES rend le droit ; rouvrir le CHAT l\'accorde', () => {
    // Deux gestes differents, deux regles differentes.
    //
    // Deverrouiller ou lever une reservation rend un droit d'ENTREE : `null`,
    // resolu par `restoreFromCategory`, pour ne pas ouvrir un salon que la
    // categorie ferme.
    expect(CHANNEL_PATCHES.unlock.Connect).toBeNull();
    expect(CHANNEL_PATCHES.clearReservation.Connect).toBeNull();

    // Ouvrir le chat, lui, ACCORDE. Ce test exigeait `null` ici aussi, et c'est
    // ce qui cassait le chat : le mode annoncait « Tout le monde » et rendait le
    // droit a une categorie qui le refusait — personne ne pouvait ecrire, le
    // proprietaire compris.
    expect(CHANNEL_PATCHES.openChat.SendMessages).toBe(true);
    expect(CHANNEL_PATCHES.everyone.SendMessages).toBe(true);
  });

  test('naître verrouillé ferme le chat comme le bouton', () => {
    // Les deux chemins qui verrouillent doivent laisser le même salon : sinon,
    // un salon ne le serait vraiment qu'après un aller-retour sur le bouton.
    const atCreation = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: [],
      policy: { ...defaultTempVoicePolicy(), lockOnCreate: true },
    });
    expect(has(denyOf(atCreation, EVERYONE), PermissionFlagsBits.SendMessages)).toBeTrue();

    // Sauf si le chat est explicitement ouvert : le réglage tranche alors.
    const chatOpened = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: [],
      policy: { ...defaultTempVoicePolicy(), lockOnCreate: true, textChat: 'open' },
    });
    expect(has(denyOf(chatOpened, EVERYONE), PermissionFlagsBits.SendMessages)).toBeFalse();
    expect(has(allowOf(chatOpened, EVERYONE), PermissionFlagsBits.SendMessages)).toBeTrue();
  });

  test('verrouiller ferme la connexion et le chat, jamais la visibilité', () => {
    // Le chat textuel suit l'accès, sinon un salon verrouillé laisse ceux qui le
    // voient y écrire quand même. La visibilité, elle, n'est jamais modifiée
    // par le panneau : un salon verrouillé reste lisible par ceux qui le
    // voyaient déjà.
    expect(CHANNEL_PATCHES.lock).toEqual({ Connect: false, SendMessages: false });
    expect(CHANNEL_PATCHES.unlock).toEqual({ Connect: null, SendMessages: null });
  });

  test('bannir coupe aussi le chat textuel', () => {
    // Le bannissement ne coupait que la connexion : le banni continuait de lire
    // et d'écrire dans le chat du salon dont on venait de le sortir.
    expect(CHANNEL_PATCHES.ban.Connect).toBe(false);
    expect(CHANNEL_PATCHES.ban.ViewChannel).toBe(false);
    expect(CHANNEL_PATCHES.ban.SendMessages).toBe(false);
  });
});

describe('restoreFromCategory', () => {
  /**
   * Un salon ne lit pas les surcharges de sa catégorie : celles-ci y ont été
   * recopiées à la création. Écrire `null` efface donc le refus recopié et rend
   * le droit à celui du rôle @everyone du serveur, pas à la catégorie.
   */
  test('déverrouiller garde le refus de connexion que porte la catégorie', () => {
    const categoryEveryone = { allow: 0n, deny: PermissionFlagsBits.Connect };

    expect(restoreFromCategory(CHANNEL_PATCHES.unlock, categoryEveryone))
      .toEqual({ Connect: false, SendMessages: null });
  });

  test('un droit ACCORDE traverse restoreFromCategory sans etre repris', () => {
    // Ce test exigeait l'inverse : que rouvrir le chat garde le refus de la
    // categorie. C'est ce qui le cassait. `restoreFromCategory` ne reprend que
    // ce qui vaut `null` — une valeur explicite passe, et c'est voulu.
    const categoryEveryone = { allow: 0n, deny: PermissionFlagsBits.SendMessages };

    expect(restoreFromCategory(CHANNEL_PATCHES.openChat, categoryEveryone))
      .toEqual({ SendMessages: true });
    // Le droit d'ENTREE, lui, reste soumis a la categorie.
    expect(restoreFromCategory(CHANNEL_PATCHES.unlock, { allow: 0n, deny: PermissionFlagsBits.Connect }))
      .toEqual({ Connect: false, SendMessages: null });
  });

  test('reprend une autorisation de la catégorie, sans en inventer', () => {
    const categoryEveryone = { allow: PermissionFlagsBits.Connect, deny: 0n };

    expect(restoreFromCategory(CHANNEL_PATCHES.clearReservation, categoryEveryone))
      .toEqual({ Connect: true, SendMessages: null });
    expect(restoreFromCategory(CHANNEL_PATCHES.unlock, null))
      .toEqual({ Connect: null, SendMessages: null });
  });

  test('ne touche pas aux valeurs déjà tranchées par le patch', () => {
    const categoryEveryone = { allow: PermissionFlagsBits.Connect, deny: 0n };

    expect(restoreFromCategory(CHANNEL_PATCHES.lock, categoryEveryone)).toEqual(CHANNEL_PATCHES.lock);
  });

  test('accepte les surcharges de discord.js, dont les bits sont des objets', () => {
    const categoryEveryone = { allow: { bitfield: 0n }, deny: { bitfield: PermissionFlagsBits.Connect } };

    expect(restoreFromCategory(CHANNEL_PATCHES.unlock, categoryEveryone).Connect).toBe(false);
  });
});

describe('ownerChatPatch', () => {
  test('fermer le chat laisse le propriétaire écrire', () => {
    // Sans surcharge nommée posée à la création, « Verrouiller » ou « Fermer le chat »
    // rendait le propriétaire muet dans son propre salon.
    expect(ownerChatPatch(true, null)).toEqual({ SendMessages: true });
  });

  test('un refus nommé de la catégorie l\'emporte à la fermeture', () => {
    const category = { allow: 0n, deny: PermissionFlagsBits.SendMessages };
    expect(ownerChatPatch(true, category)).toEqual({ SendMessages: false });
  });

  test('rouvrir rend le droit à la catégorie', () => {
    expect(ownerChatPatch(false, null)).toEqual({ SendMessages: null });
    expect(ownerChatPatch(false, { allow: PermissionFlagsBits.SendMessages, deny: 0n }))
      .toEqual({ SendMessages: true });
  });
});

describe('ownerPowersFromBits / ownerPermissionPatch', () => {
  test('relit les pouvoirs réellement posés sur un salon', () => {
    const allow = PermissionFlagsBits.Connect | PermissionFlagsBits.MoveMembers | PermissionFlagsBits.ManageMessages;

    expect(ownerPowersFromBits(allow)).toEqual(['move', 'manageMessages']);
  });

  test('un transfert reconduit les pouvoirs de l\'ancien propriétaire', () => {
    // Le salon ne retient pas quel générateur l'a créé, et la politique a pu
    // changer depuis : ce que le salon porte est la seule source fiable.
    const patch = ownerPermissionPatch(ownerPowersFromBits(PermissionFlagsBits.MuteMembers));

    expect(patch.MuteMembers).toBe(true);
    expect(patch.Connect).toBe(true);
    // Un pouvoir non accordé vaut `null` et non `false` : le refuser couperait
    // le membre de ce que ses rôles lui donnent ailleurs sur le serveur.
    expect(patch.MoveMembers).toBeNull();
    expect(patch.ManageChannels).toBeNull();
  });

  test('rend au propriétaire sortant tout ce qu\'un transfert doit reprendre', () => {
    // L'ancien propriétaire gardait ses pouvoirs de modération vocale sur un
    // salon qui n'était plus le sien.
    const revoked = ownerRevokedPermissions();

    expect(Object.values(revoked).every((value) => value === null)).toBe(true);
    expect(Object.keys(revoked)).toContain('MuteMembers');
    expect(Object.keys(revoked)).toContain('SendMessages');
  });
});

describe('régressions relevées en revue', () => {
  /** Catégorie fermée : ni visible ni joignable par @everyone. */
  const closedCategory: OverwriteDraft[] = [
    {
      id: EVERYONE,
      type: OverwriteType.Role,
      allow: 0n,
      deny: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect,
    },
  ];

  test('@everyone ne peut pas être un rôle autorisé d\'office', () => {
    // Son identifiant est celui du serveur : il passe la validation de format.
    expect(normalizeTempVoicePolicy({ autoAllowRoleIds: [EVERYONE, VIP_ROLE] }, EVERYONE).autoAllowRoleIds)
      .toEqual([VIP_ROLE]);

    // Et si la valeur vient d'une base écrite avant ce filtrage, la création ne
    // doit pas la suivre non plus. Le cas qui tranche est le salon ouvert, sans
    // héritage : la politique ne demande aucune surcharge @everyone, donc si
    // l'autorisation d'office en pose une, c'est qu'elle a accordé à tout le
    // serveur des droits que rien ne lui rendrait ensuite. Sur une catégorie
    // fermée, au contraire, le refus hérité masquerait l'absence de garde-fou.
    const openCategory = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: [],
      policy: { ...defaultTempVoicePolicy(), autoAllowRoleIds: [EVERYONE] },
    });
    expect(findOverwrite(openCategory, EVERYONE)).toBeUndefined();

    const closedCategoryCase = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: closedCategory,
      policy: { ...defaultTempVoicePolicy(), autoAllowRoleIds: [EVERYONE] },
    });
    expect(has(denyOf(closedCategoryCase, EVERYONE), PermissionFlagsBits.ViewChannel)).toBeTrue();
  });

  test('un transfert n\'accorde pas ce que la catégorie refuse à la cible', () => {
    // Le refus est reposé en `false` : `null` effacerait celui que le salon a
    // recopié de la catégorie, et rendrait la parole au membre sanctionné.
    const patch = ownerPermissionPatch(['mute'], { allow: 0n, deny: PermissionFlagsBits.Speak });

    expect(patch.Speak).toBe(false);
    expect(patch.Connect).toBe(true);
    expect(patch.MuteMembers).toBe(true);

    // Une catégorie qui refuse aussi le pouvoir coché ne le laisse pas passer.
    expect(ownerPermissionPatch(['mute'], { allow: 0n, deny: PermissionFlagsBits.MuteMembers }).MuteMembers)
      .toBe(false);
  });

  test('un membre ordinaire reçoit les pouvoirs du salon', () => {
    // Personne n'a « Rendre muet » dans une catégorie sans être modérateur :
    // confronter les pouvoirs aux droits effectifs les retirait à chaque
    // transfert, et le suivant n'en relisait plus aucun.
    const patch = ownerPermissionPatch([...LEGACY_OWNER_POWERS], null);

    expect(patch.MuteMembers).toBe(true);
    expect(patch.DeafenMembers).toBe(true);
    expect(patch.MoveMembers).toBe(true);
    expect(ownerPowersFromBits(PermissionFlagsBits.MuteMembers | PermissionFlagsBits.DeafenMembers | PermissionFlagsBits.MoveMembers))
      .toEqual([...LEGACY_OWNER_POWERS]);
  });

  test('le propriétaire sortant garde les refus que la catégorie lui pose', () => {
    const returned = ownerRevokedPermissions({ allow: 0n, deny: PermissionFlagsBits.Speak });

    expect(returned.Speak).toBe(false);
    expect(returned.Connect).toBeNull();
    expect(returned.MuteMembers).toBeNull();
  });

  test('le propriétaire sortant rend aussi son accès au salon', () => {
    // Garder vue, connexion et parole en surcharge nominative laissait chaque
    // ancien propriétaire entrer dans un salon verrouillé, définitivement : au
    // bout de deux transferts, « Verrouiller » ne fermait plus rien.
    const returned = ownerRevokedPermissions();

    for (const droit of ['ViewChannel', 'Connect', 'Speak', 'SendMessages', 'ReadMessageHistory']) {
      expect(returned[droit]).toBeNull();
    }
    // Tout ce que le patch de propriété accorde doit revenir à l'héritage.
    expect(Object.keys(returned).sort()).toEqual(Object.keys(ownerPermissionPatch([])).sort());
  });

  test('le nouveau propriétaire reçoit le droit d\'écrire, l\'ancien le rend', () => {
    // L'ancien propriétaire rend son `SendMessages` au transfert : sans le
    // symetrique sur le nouveau, le salon changeait de main en restant muet.
    expect(ownerPermissionPatch(['mute']).SendMessages).toBeTrue();
    expect(ownerPermissionPatch(['mute']).ReadMessageHistory).toBeTrue();

    // Rendu vaut `null` et non `false` : l'ancien propriétaire reste un membre
    // comme les autres, il ne devient pas muet dans le salon.
    expect(ownerRevokedPermissions().SendMessages).toBeNull();
    expect(ownerRevokedPermissions().ReadMessageHistory).toBeNull();
  });

  test('les écritures de surcharges exigent ManageRoles', () => {
    // Toutes les écritures du module sont des `permissionOverwrites.edit`, et
    // créer un salon avec des surcharges l'exige aussi. Un bot sans ce droit
    // passait la porte puis echouait partout ensuite.
    expect(requiredBotPermissions(defaultTempVoicePolicy())).toContain(PermissionFlagsBits.ManageRoles);
  });

  test('les droits exigés du bot suivent la politique', () => {
    // Discord refuse un salon dont une surcharge accorde un droit que le bot
    // n'a pas.
    const withoutPower = requiredBotPermissions({ ...defaultTempVoicePolicy(), ownerPowers: [] });
    const withMessages = requiredBotPermissions({ ...defaultTempVoicePolicy(), ownerPowers: ['manageMessages'] });

    expect(withoutPower).toContain(PermissionFlagsBits.ManageChannels);
    expect(withoutPower).not.toContain(PermissionFlagsBits.ManageMessages);
    expect(withMessages).toContain(PermissionFlagsBits.ManageMessages);
  });

  test('un pseudo contenant $& n\'est pas interprété', () => {
    expect(renderChannelName('Salon de {user}', '$&')).toBe('Salon de $&');
    expect(renderChannelName('{user}', "a$'b")).toBe("a$'b");
  });

  test('le générateur principal se reconnaît, il ne se devine pas', () => {
    // Un serveur peut n'avoir que des générateurs additionnels.
    const base = {
      tempVoiceEnabled: true,
      tempVoiceCategoryId: null,
      tempVoiceNameTemplate: '🔊 Salon de {user}',
      tempVoiceGenerators: [{ channelId: OTHER_ROLE }],
    };

    expect(resolveTempVoiceGenerators({ ...base, tempVoiceChannelId: VIP_ROLE })
      .find((entry) => entry.primary)?.channelId).toBe(VIP_ROLE);
    expect(resolveTempVoiceGenerators({ ...base, tempVoiceChannelId: null })
      .find((entry) => entry.primary)).toBeUndefined();
  });
});

describe('trustPermissionPatch', () => {
  const ALL_TRUST_BITS = PermissionFlagsBits.ViewChannel
    | PermissionFlagsBits.Connect
    | PermissionFlagsBits.Speak
    | PermissionFlagsBits.SendMessages
    | PermissionFlagsBits.ReadMessageHistory;

  test('un accès complet ouvre aussi le chat textuel du salon', () => {
    // Verrouiller ferme l'écriture à @everyone : un membre ajouté qui ne
    // recevrait que la connexion se retrouverait muet dans le salon.
    const patch = trustPermissionPatch(ALL_TRUST_BITS);

    expect(patch).toEqual({
      ViewChannel: true,
      Connect: true,
      Speak: true,
      SendMessages: true,
      ReadMessageHistory: true,
    });
    expect(Object.keys(patch ?? {})).toHaveLength(TRUST_BIT_COUNT);
  });

  test('refuse une cible introuvable, même sur un salon sans catégorie', () => {
    // La garde sur la cible venait après celle sur la catégorie : un salon non
    // rangé accordait alors les cinq droits à une cible que personne n'avait su
    // résoudre.
    expect(categoryTrustPatch({ parentId: null, parent: null }, null)).toBeNull();
    expect(categoryTrustPatch({ parentId: null, parent: null }, { id: 'x' })).not.toBeNull();
  });

  test('n\'accorde que ce que la catégorie laisse réellement à la cible', () => {
    // Le cas courant : la catégorie refuse la vue à @everyone et l'autorise à un
    // rôle. Une cible sans ce rôle n'a pas ViewChannel dans ses droits effectifs.
    const patch = trustPermissionPatch(PermissionFlagsBits.Connect | PermissionFlagsBits.Speak);

    expect(patch?.ViewChannel).toBeUndefined();
    expect(patch?.Connect).toBeTrue();
    expect(patch?.Speak).toBeTrue();
  });

  test('rend null quand la catégorie ne laisse rien', () => {
    expect(trustPermissionPatch(0n)).toBeNull();
  });

  test('accorde tout quand la catégorie laisse tout', () => {
    const patch = trustPermissionPatch(ALL_TRUST_BITS);

    expect(patch?.ViewChannel).toBeTrue();
    expect(patch?.Connect).toBeTrue();
    expect(patch?.Speak).toBeTrue();
  });

  test('un salon sans catégorie n\'a aucune restriction à respecter', () => {
    const patch = trustPermissionPatch(null);

    expect(patch?.ViewChannel).toBeTrue();
    expect(patch?.Speak).toBeTrue();
  });
});

describe('resolveReservationRoleId', () => {
  /**
   * La route posait `body.roleId` directement dans une surcharge. Avec
   * l'identifiant du serveur, elle autorisait @everyone à voir et rejoindre le
   * salon.
   */
  const guildRoles = new Set([VIP_ROLE, OTHER_ROLE]);

  test('refuse le rôle @everyone, qui porte l\'identifiant du serveur', () => {
    expect(resolveReservationRoleId(EVERYONE, EVERYONE, guildRoles)).toBeNull();
  });

  test('refuse un rôle qui n\'existe pas sur ce serveur', () => {
    expect(resolveReservationRoleId('500000000000000000', EVERYONE, guildRoles)).toBeNull();
  });

  test('refuse ce qui n\'est pas un identifiant', () => {
    expect(resolveReservationRoleId('everyone', EVERYONE, guildRoles)).toBeNull();
    expect(resolveReservationRoleId(42, EVERYONE, guildRoles)).toBeNull();
  });

  test('accepte un rôle du serveur', () => {
    expect(resolveReservationRoleId(VIP_ROLE, EVERYONE, guildRoles)).toBe(VIP_ROLE);
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
  test('remplace le pseudo et coupe à la longueur acceptée', () => {
    expect(renderChannelName('🔊 Salon de {user}', 'Alex')).toBe('🔊 Salon de Alex');
    expect(renderChannelName('{user}', 'x'.repeat(200))).toHaveLength(100);
  });

  test('ne rend jamais un nom vide', () => {
    // Discord refuse un nom vide : le salon ne serait pas créé, et le membre
    // resterait bloque dans le générateur sans explication.
    expect(renderChannelName('{user}', '   ').length).toBeGreaterThan(0);
  });
});
