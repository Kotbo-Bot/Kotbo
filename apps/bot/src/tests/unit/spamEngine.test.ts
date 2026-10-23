import { describe, expect, test } from 'bun:test';

// Le moteur anti-spam est volontairement sans dépendance à Prisma ni à
// discord.js : ces modules s'importent directement, sans mock.
import {
  normalizeContent,
  similarity,
  detectUnicodeObfuscation,
  containsInvite,
} from '../../services/moderation/spam/normalize.js';
import { collectSignals } from '../../services/moderation/spam/signals.js';
import { computeSpamScore, evaluateMessage, trustMultiplier } from '../../services/moderation/spam/scoring.js';
import {
  getTypingSessionStartAt,
  recordMessage,
  recordTyping,
  resetActivityStore,
} from '../../services/moderation/spam/activityStore.js';
import {
  DEFAULT_TUNING,
  resolveAction,
  type RecentMessage,
  type SpamEvaluationContext,
  type SpamSignal,
  type SpamThresholds,
  type TrustContext,
} from '../../services/moderation/spam/types.js';

const NOW = 1_700_000_000_000;

const NEWCOMER: TrustContext = {
  accountAgeMs: 2 * 24 * 60 * 60 * 1000,
  membershipMs: 60 * 60 * 1000,
  messageCount: 1,
  hasRole: false,
  isTrustedRole: false,
};

const VETERAN: TrustContext = {
  accountAgeMs: 4 * 365 * 24 * 60 * 60 * 1000,
  membershipMs: 2 * 365 * 24 * 60 * 60 * 1000,
  messageCount: 8000,
  hasRole: true,
  isTrustedRole: true,
};

function ctx(overrides: Partial<SpamEvaluationContext> = {}): SpamEvaluationContext {
  return {
    now: NOW,
    content: 'un message parfaitement ordinaire sur le serveur',
    channelId: 'chan-1',
    attachmentCount: 0,
    mentionCount: 0,
    mentionedEveryone: false,
    history: [],
    lastTypingAt: NOW - 2000,
    typingSessionStartAt: NOW - 60_000,
    typingObservable: true,
    trust: VETERAN,
    tuning: DEFAULT_TUNING,
    ...overrides,
  };
}

function msg(overrides: Partial<RecentMessage> = {}): RecentMessage {
  return {
    at: NOW - 5000,
    channelId: 'chan-1',
    normalized: normalizeContent('un message'),
    length: 10,
    hasAttachment: false,
    ...overrides,
  };
}

function typesOf(signals: SpamSignal[]): string[] {
  return signals.map((s) => s.type).sort();
}

describe('normalizeContent', () => {
  test('replie les homoglyphes cyrilliques sur leur equivalent latin', () => {
    // « і » et « о » sont ici cyrilliques : le rendu visuel est identique.
    expect(normalizeContent('dіscоrd')).toBe(normalizeContent('discord'));
  });

  test('supprime les caracteres invisibles', () => {
    expect(normalizeContent('free​nitro')).toBe('freenitro');
  });

  test('reduit une URL a son hote', () => {
    const a = normalizeContent('clique ici https://evil.example/aaa?ref=1');
    const b = normalizeContent('clique ici https://evil.example/bbb?ref=2');
    expect(a).toBe(b);
    expect(a).toContain('url:evil.example');
  });

  test('retire les mentions et emojis personnalises', () => {
    expect(normalizeContent('salut <@123456789012345678> <:kek:987654321098765432>')).toBe('salut');
  });
});

describe('similarity', () => {
  test('renvoie 1 pour deux textes identiques', () => {
    expect(similarity('bonjour tout le monde', 'bonjour tout le monde')).toBe(1);
  });

  test('reste elevee malgre une petite variation', () => {
    const score = similarity(
      normalizeContent('free nitro pour tout le monde clique vite'),
      normalizeContent('free nitro pour tout le monde clique vite !!')
    );
    expect(score).toBeGreaterThan(0.85);
  });

  test('reste basse pour deux messages differents', () => {
    const score = similarity(
      normalizeContent('quelqu un a vu le dernier episode'),
      normalizeContent('je cherche un coequipier pour ce soir')
    );
    expect(score).toBeLessThan(0.3);
  });

  test('ne rapproche pas deux textes tres courts', () => {
    // « ok » et « oki » partagent presque tous leurs trigrammes sans rien vouloir
    // dire : les rapprocher produirait des faux positifs en conversation.
    expect(similarity('ok', 'oki')).toBe(0);
  });
});

describe('detectUnicodeObfuscation', () => {
  test('detecte un melange d alphabets dans un meme mot', () => {
    expect(detectUnicodeObfuscation('dіscord').detected).toBe(true);
  });

  test('accepte un texte entierement cyrillique', () => {
    expect(detectUnicodeObfuscation('привет как дела').detected).toBe(false);
  });

  test('accepte un texte latin ordinaire', () => {
    expect(detectUnicodeObfuscation('bonjour tout le monde').detected).toBe(false);
  });
});

describe('containsInvite', () => {
  test('reconnait les formes courantes d invitation', () => {
    expect(containsInvite('rejoins discord.gg/abc123')).toBe(true);
    expect(containsInvite('https://discord.com/invite/xyz789')).toBe(true);
    expect(containsInvite('rien a voir')).toBe(false);
  });
});

describe('signal : message sans indicateur de frappe', () => {
  const long = 'a'.repeat(80);

  test('se declenche sur un message long sans frappe observee', () => {
    const signals = collectSignals(ctx({ content: long, lastTypingAt: null }));
    expect(typesOf(signals)).toContain('no_typing');
  });

  test('ne se declenche pas si une frappe recente est connue', () => {
    const signals = collectSignals(ctx({ content: long, lastTypingAt: NOW - 3000 }));
    expect(typesOf(signals)).not.toContain('no_typing');
  });

  test('ne se declenche pas sur un message court', () => {
    const signals = collectSignals(ctx({ content: 'ok', lastTypingAt: null }));
    expect(typesOf(signals)).not.toContain('no_typing');
  });

  test('reste muet quand le bot ne recoit pas les evenements de frappe', () => {
    // Sans cette garde, l'absence d'intent marquerait tout le serveur.
    const signals = collectSignals(ctx({ content: long, lastTypingAt: null, typingObservable: false }));
    expect(typesOf(signals)).not.toContain('no_typing');
  });
});

describe('signal : copier-coller', () => {
  const pasted = 'Gagne 50 euros de Nitro gratuit, clique vite sur le lien avant la fin de l offre. '.repeat(4);

  test('se declenche sur un gros message envoye une seconde apres la premiere frappe', () => {
    const signals = collectSignals(ctx({ content: pasted, lastTypingAt: NOW - 1000, typingSessionStartAt: NOW - 1000 }));
    const paste = signals.find((s) => s.type === 'paste_burst');
    expect(paste).toBeDefined();
    expect(paste!.score).toBe(35);
  });

  test('pese moins quand la frappe est courte mais pas instantanee', () => {
    // ~330 caracteres en 10 s : 33 car./s, impossible a taper mais pas instantane.
    const signals = collectSignals(ctx({ content: pasted, lastTypingAt: NOW - 2000, typingSessionStartAt: NOW - 10_000 }));
    expect(signals.find((s) => s.type === 'paste_burst')?.score).toBe(25);
  });

  test('ne se declenche pas quand le temps de frappe suffit a ecrire le texte', () => {
    const signals = collectSignals(ctx({ content: pasted, lastTypingAt: NOW - 2000, typingSessionStartAt: NOW - 45_000 }));
    expect(typesOf(signals)).not.toContain('paste_burst');
  });

  test('ne se declenche pas sur un message court colle', () => {
    const signals = collectSignals(ctx({ content: 'a'.repeat(120), lastTypingAt: NOW - 500, typingSessionStartAt: NOW - 500 }));
    expect(typesOf(signals)).not.toContain('paste_burst');
  });

  test('ignore les blocs de code', () => {
    const code = '```ts\n' + 'const x = 1;\n'.repeat(30) + '```';
    const signals = collectSignals(ctx({ content: code, lastTypingAt: NOW - 500, typingSessionStartAt: NOW - 500 }));
    expect(typesOf(signals)).not.toContain('paste_burst');
  });

  test('laisse le cas sans aucune frappe a no_typing', () => {
    const signals = collectSignals(ctx({ content: pasted, lastTypingAt: null, typingSessionStartAt: null }));
    expect(typesOf(signals)).toContain('no_typing');
    expect(typesOf(signals)).not.toContain('paste_burst');
  });

  test('reste muet quand le bot ne recoit pas les evenements de frappe', () => {
    const signals = collectSignals(
      ctx({ content: pasted, lastTypingAt: NOW - 500, typingSessionStartAt: NOW - 500, typingObservable: false })
    );
    expect(typesOf(signals)).not.toContain('paste_burst');
  });

  test('se desactive avec son reglage', () => {
    const signals = collectSignals(
      ctx({
        content: pasted,
        lastTypingAt: NOW - 500,
        typingSessionStartAt: NOW - 500,
        tuning: { ...DEFAULT_TUNING, pasteSignalEnabled: false },
      })
    );
    expect(typesOf(signals)).not.toContain('paste_burst');
  });

  test('ne decide pas seul pour un membre installe', () => {
    const verdict = evaluateMessage(ctx({ content: pasted, lastTypingAt: NOW - 500, typingSessionStartAt: NOW - 500 }));
    expect(verdict.score).toBeLessThan(55);
  });
});

describe('activite : saisie en cours', () => {
  const at = (s: number) => NOW + s * 1000;

  test('la saisie commence a la premiere frappe et survit aux relances', () => {
    resetActivityStore();
    recordTyping('g', 'u', at(0));
    recordTyping('g', 'u', at(10));
    recordTyping('g', 'u', at(20));
    expect(getTypingSessionStartAt('g', 'u')).toBe(at(0));
  });

  test('un message envoye clot la saisie', () => {
    resetActivityStore();
    recordTyping('g', 'u', at(0));
    recordMessage('g', 'u', msg({ at: at(5) }));
    expect(getTypingSessionStartAt('g', 'u')).toBeNull();
    recordTyping('g', 'u', at(8));
    expect(getTypingSessionStartAt('g', 'u')).toBe(at(8));
  });

  test('un long silence ouvre une nouvelle saisie', () => {
    resetActivityStore();
    recordTyping('g', 'u', at(0));
    recordTyping('g', 'u', at(600));
    expect(getTypingSessionStartAt('g', 'u')).toBe(at(600));
  });
});

describe('signal : diffusion multi-salons', () => {
  const payload = 'free nitro pour tous cliquez sur ce lien maintenant';

  test('se declenche quand le meme message part dans plusieurs salons', () => {
    const normalized = normalizeContent(payload);
    const signals = collectSignals(
      ctx({
        content: payload,
        channelId: 'chan-4',
        history: [
          msg({ at: NOW - 4000, channelId: 'chan-1', normalized }),
          msg({ at: NOW - 3000, channelId: 'chan-2', normalized }),
          msg({ at: NOW - 2000, channelId: 'chan-3', normalized }),
        ],
      })
    );
    expect(typesOf(signals)).toContain('cross_channel_burst');
  });

  test('ne se declenche pas pour des messages differents dans plusieurs salons', () => {
    const signals = collectSignals(
      ctx({
        content: payload,
        channelId: 'chan-4',
        history: [
          msg({ at: NOW - 4000, channelId: 'chan-1', normalized: normalizeContent('salut ca va bien ou quoi') }),
          msg({ at: NOW - 3000, channelId: 'chan-2', normalized: normalizeContent('je cherche un coequipier') }),
          msg({ at: NOW - 2000, channelId: 'chan-3', normalized: normalizeContent('merci pour ton aide hier') }),
        ],
      })
    );
    expect(typesOf(signals)).not.toContain('cross_channel_burst');
  });

  test('ignore l historique sorti de la fenetre', () => {
    const normalized = normalizeContent(payload);
    const old = NOW - 120_000; // bien au-dela des 30 s de fenetre
    const signals = collectSignals(
      ctx({
        content: payload,
        channelId: 'chan-4',
        history: [
          msg({ at: old, channelId: 'chan-1', normalized }),
          msg({ at: old, channelId: 'chan-2', normalized }),
          msg({ at: old, channelId: 'chan-3', normalized }),
        ],
      })
    );
    expect(typesOf(signals)).not.toContain('cross_channel_burst');
  });
});

describe('signal : repetition', () => {
  const PITCH = 'achetez des skins pas chers ici avec le code promo 1111';

  test('marque la repetition strictement identique', () => {
    const normalized = normalizeContent(PITCH);
    const signals = collectSignals(
      ctx({
        content: PITCH,
        history: [msg({ at: NOW - 3000, normalized }), msg({ at: NOW - 1500, normalized })],
      })
    );
    expect(typesOf(signals)).toContain('repeat_identical');
  });

  test('marque aussi les variantes destinees a casser la comparaison exacte', () => {
    const signals = collectSignals(
      ctx({
        content: PITCH,
        history: [
          msg({ at: NOW - 3000, normalized: normalizeContent('achetez des skins pas chers ici avec le code promo 2222') }),
          msg({ at: NOW - 1500, normalized: normalizeContent('achetez vos skins pas chers ici avec le code promo 1111') }),
        ],
      })
    );
    expect(typesOf(signals)).toContain('near_duplicate');
  });

  test('la ponctuation seule ne cree pas de variante : la normalisation l absorbe', () => {
    const signals = collectSignals(
      ctx({
        content: PITCH,
        history: [
          msg({ at: NOW - 3000, normalized: normalizeContent(`${PITCH} !`) }),
          msg({ at: NOW - 1500, normalized: normalizeContent(`${PITCH} ??`) }),
        ],
      })
    );
    expect(typesOf(signals)).toContain('repeat_identical');
  });
});

describe('signal : cadence', () => {
  test('detecte un debit inhumain', () => {
    const history = [0, 1, 2, 3].map((i) => msg({ at: NOW - 2500 + i * 500 }));
    const signals = collectSignals(ctx({ history }));
    expect(typesOf(signals)).toContain('inhuman_rate');
  });

  test('detecte des intervalles trop reguliers', () => {
    // Six messages espaces d'exactement 4 s : signature d'une boucle.
    const history = [0, 1, 2, 3, 4].map((i) => msg({ at: NOW - 20_000 + i * 4000 }));
    const signals = collectSignals(ctx({ history }));
    expect(typesOf(signals)).toContain('regular_intervals');
  });

  test('ne marque pas une conversation humaine irreguliere', () => {
    const offsets = [22_000, 15_000, 11_000, 4000, 1500];
    const history = offsets.map((o) => msg({ at: NOW - o }));
    const signals = collectSignals(ctx({ history }));
    expect(typesOf(signals)).not.toContain('regular_intervals');
    expect(typesOf(signals)).not.toContain('inhuman_rate');
  });
});

describe('signal : contenu', () => {
  test('detecte une tentative de mention globale sans permission', () => {
    const signals = collectSignals(ctx({ content: '@everyone free nitro', mentionedEveryone: false }));
    expect(typesOf(signals)).toContain('everyone_attempt');
  });

  test('ne marque pas une mention globale legitime', () => {
    const signals = collectSignals(ctx({ content: '@everyone maintenance ce soir', mentionedEveryone: true }));
    expect(typesOf(signals)).not.toContain('everyone_attempt');
  });

  test('detecte une rafale de mentions', () => {
    expect(typesOf(collectSignals(ctx({ mentionCount: 12 })))).toContain('mention_burst');
    expect(typesOf(collectSignals(ctx({ mentionCount: 2 })))).not.toContain('mention_burst');
  });
});

describe('trustMultiplier', () => {
  test('attenue fortement un membre installe', () => {
    expect(trustMultiplier(VETERAN)).toBeLessThan(0.5);
  });

  test('n attenue pas un compte inconnu', () => {
    expect(trustMultiplier(NEWCOMER)).toBeGreaterThan(0.9);
  });

  test('ne descend jamais sous le plancher', () => {
    // Un membre de confiance dont le compte est vole doit rester detectable.
    expect(trustMultiplier(VETERAN)).toBeGreaterThanOrEqual(0.4);
  });
});

describe('computeSpamScore', () => {
  test('renvoie 0 sans signal', () => {
    expect(computeSpamScore([]).score).toBe(0);
  });

  test('applique des rendements decroissants dans une meme famille', () => {
    const one = computeSpamScore([{ type: 'near_duplicate', score: 40, label: 'a' }]);
    const two = computeSpamScore([
      { type: 'near_duplicate', score: 40, label: 'a' },
      { type: 'repeat_identical', score: 40, label: 'b' },
    ]);
    // Deux signaux de repetition disent la meme chose : le second ne doit pas
    // compter autant que le premier.
    expect(two.score).toBeLessThan(one.score * 2);
    expect(two.score).toBeGreaterThan(one.score);
  });

  test('recompense la corroboration entre familles distinctes', () => {
    const sameFamily = computeSpamScore([
      { type: 'near_duplicate', score: 40, label: 'a' },
      { type: 'repeat_identical', score: 40, label: 'b' },
    ]);
    const crossFamily = computeSpamScore([
      { type: 'near_duplicate', score: 40, label: 'a' },
      { type: 'no_typing', score: 40, label: 'b' },
    ]);
    expect(crossFamily.score).toBeGreaterThan(sameFamily.score);
    expect(crossFamily.distinctFamilies).toBe(2);
  });

  test('la confiance attenue le contenu mais pas l automatisation', () => {
    const contentSignal: SpamSignal[] = [{ type: 'mention_burst', score: 50, label: 'a' }];
    const automationSignal: SpamSignal[] = [{ type: 'no_typing', score: 50, label: 'a' }];

    const contentTrusted = computeSpamScore(contentSignal, { trust: VETERAN, trustEnabled: true });
    const contentUnknown = computeSpamScore(contentSignal, { trust: NEWCOMER, trustEnabled: true });
    expect(contentTrusted.score).toBeLessThan(contentUnknown.score);

    const autoTrusted = computeSpamScore(automationSignal, { trust: VETERAN, trustEnabled: true });
    const autoUnknown = computeSpamScore(automationSignal, { trust: NEWCOMER, trustEnabled: true });
    expect(autoTrusted.score).toBe(autoUnknown.score);
  });

  test('applique les poids appris', () => {
    const signals: SpamSignal[] = [{ type: 'near_duplicate', score: 40, label: 'a' }];
    const boosted = computeSpamScore(signals, { weights: { near_duplicate: 2 } });
    const damped = computeSpamScore(signals, { weights: { near_duplicate: 0.5 } });
    expect(boosted.score).toBeGreaterThan(damped.score);
  });

  test('plafonne a 100', () => {
    const signals: SpamSignal[] = [
      { type: 'no_typing', score: 100, label: 'a' },
      { type: 'cross_channel_burst', score: 100, label: 'b' },
      { type: 'near_duplicate', score: 100, label: 'c' },
      { type: 'mention_burst', score: 100, label: 'd' },
    ];
    expect(computeSpamScore(signals).score).toBe(100);
  });
});

describe('resolveAction', () => {
  const thresholds: SpamThresholds = {
    logThreshold: 30,
    deleteThreshold: 55,
    timeoutThreshold: 75,
    banThreshold: 95,
  };

  test('mappe chaque palier', () => {
    expect(resolveAction(10, thresholds)).toBe('NONE');
    expect(resolveAction(30, thresholds)).toBe('LOG');
    expect(resolveAction(60, thresholds)).toBe('DELETE');
    expect(resolveAction(80, thresholds)).toBe('TIMEOUT');
    expect(resolveAction(100, thresholds)).toBe('BAN');
  });

  test('un seuil de bannissement a 101 desactive le palier', () => {
    expect(resolveAction(100, { ...thresholds, banThreshold: 101 })).toBe('TIMEOUT');
  });
});

describe('evaluateMessage : scenarios de bout en bout', () => {
  test('une conversation ordinaire ne declenche rien', () => {
    const verdict = evaluateMessage(
      ctx({
        content: 'ouais je suis d accord avec toi sur ce point la',
        history: [
          msg({ at: NOW - 40_000, normalized: normalizeContent('salut tout le monde') }),
          msg({ at: NOW - 18_000, normalized: normalizeContent('quelqu un a essaye la nouvelle map') }),
        ],
      })
    );
    expect(verdict.score).toBe(0);
  });

  test('un compte compromis qui diffuse un lien est fortement score', () => {
    const payload = 'FREE NITRO steamcommunnity.com/gift/12345 recuperez le vite avant la fin';
    const normalized = normalizeContent(payload);

    const verdict = evaluateMessage(
      ctx({
        content: payload,
        channelId: 'chan-5',
        lastTypingAt: null,
        trust: VETERAN, // compte de confiance : c'est bien le scenario du vol de session
        history: [
          msg({ at: NOW - 3000, channelId: 'chan-1', normalized }),
          msg({ at: NOW - 2000, channelId: 'chan-2', normalized }),
          msg({ at: NOW - 1000, channelId: 'chan-3', normalized }),
          msg({ at: NOW - 500, channelId: 'chan-4', normalized }),
        ],
      })
    );

    expect(verdict.score).toBeGreaterThanOrEqual(75);
    expect(typesOf(verdict.signals)).toContain('cross_channel_burst');
    expect(typesOf(verdict.signals)).toContain('no_typing');
  });

  test('un nouveau membre qui poste un lien est signale sans etre sanctionne', () => {
    const verdict = evaluateMessage(
      ctx({
        content: 'salut, voici mon portfolio https://mon-site.example',
        trust: NEWCOMER,
        lastTypingAt: NOW - 4000,
      })
    );
    // Suffisant pour journaliser, insuffisant pour supprimer : un lien seul
    // n'est pas une preuve.
    expect(verdict.score).toBeGreaterThan(0);
    expect(verdict.score).toBeLessThan(55);
  });

  test('desactiver une famille de signaux la retire du score', () => {
    const long = 'a'.repeat(90);
    const base = ctx({ content: long, lastTypingAt: null, trust: NEWCOMER });
    const withTyping = evaluateMessage(base);
    const withoutTyping = evaluateMessage({
      ...base,
      tuning: { ...DEFAULT_TUNING, typingSignalEnabled: false },
    });
    expect(withoutTyping.score).toBeLessThan(withTyping.score);
  });
});
