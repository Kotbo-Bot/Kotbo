import { describe, expect, test } from 'bun:test';
import {
  RuleSimulationError,
  compileRule,
  falsePositiveHint,
  findSpamBursts,
  keywordToRegex,
  parseSimulatedRule,
} from '../../services/moderation/ruleSimulation.js';

let seq = 0;
function msg(content: string, extra: Partial<{ authorId: string; mentionCount: number; at: number }> = {}) {
  seq += 1;
  return {
    messageId: `m${seq}`,
    channelId: 'c1',
    authorId: extra.authorId ?? 'u1',
    content,
    mentionCount: extra.mentionCount ?? 0,
    createdAt: new Date(extra.at ?? seq * 1000),
  };
}

describe('mots-clés façon Discord', () => {
  const hits = (keyword: string, text: string) => [...text.matchAll(keywordToRegex(keyword)!)].map((m) => m[0]);

  test('mot entier par défaut', () => {
    expect(hits('chat', 'Le chat dort')).toEqual(['chat']);
    expect(hits('chat', 'un chaton')).toEqual([]);
    expect(hits('chat', 'CHAT !')).toEqual(['CHAT']);
  });

  test('jokers en début, en fin, des deux côtés', () => {
    expect(hits('*chat', 'le tchat')).toEqual(['tchat']);
    expect(hits('chat*', 'un chaton')).toEqual(['chaton']);
    expect(hits('*chat*', 'des achats')).toEqual(['achats']);
  });

  test('les accents comptent comme des lettres', () => {
    expect(hits('été', 'un été chaud')).toEqual(['été']);
    expect(hits('été', 'arrêtées')).toEqual([]);
  });

  test("la liste d'autorisations neutralise un passage", () => {
    const rule = compileRule(parseSimulatedRule({ kind: 'keywords', keywords: ['*con*'], allowList: ['*conseil*'] }));
    expect(rule.test(msg('un bon conseil'))).toBeNull();
    expect(rule.test(msg('quel con'))?.detail).toContain('*con*');
  });

  test('les passages trouvés sont surlignés dans l’ordre', () => {
    const rule = compileRule(parseSimulatedRule({ kind: 'keywords', keywords: ['b', 'a'] }));
    expect(rule.test(msg('a puis b'))?.highlights).toEqual([[0, 1], [7, 8]]);
  });
});

describe('règles du filtre du bot', () => {
  test('invitations, avec domaines autorisés', () => {
    const rule = compileRule(parseSimulatedRule({ kind: 'links', whitelist: ['discord.gg/kotbo'] }));
    expect(rule.test(msg('viens sur discord.gg/abc'))).not.toBeNull();
    expect(rule.test(msg('notre serveur discord.gg/kotbo'))).toBeNull();
    expect(rule.test(msg('https://example.com'))).toBeNull();
  });

  test('majuscules au-delà du seuil', () => {
    const rule = compileRule(parseSimulatedRule({ kind: 'caps', thresholdPercent: 80, minLength: 10 }));
    expect(rule.test(msg('CE MESSAGE CRIE TRES FORT'))?.detail).toBe('100 % de majuscules');
    expect(rule.test(msg('Ceci est normal, merci'))).toBeNull();
  });

  test('émojis et mentions au-delà de la limite', () => {
    expect(compileRule(parseSimulatedRule({ kind: 'emojis', limit: 2 })).test(msg('😀😀😀'))).not.toBeNull();
    expect(compileRule(parseSimulatedRule({ kind: 'mentions', limit: 2 })).test(msg('salut', { mentionCount: 3 }))).not.toBeNull();
  });

  test('expression régulière', () => {
    const rule = compileRule(parseSimulatedRule({ kind: 'regex', pattern: 'n[i1]tr[o0]' }));
    expect(rule.test(msg('free N1TRO here'))?.highlights).toEqual([[5, 10]]);
  });

  test('arnaque : la liste de la règle remplace celle du serveur', () => {
    let seen: { scamFilterWhitelist: string[]; scamFilterCustomDomains: string[] } | null = null;
    const detect = ((content: string, config: typeof seen) => {
      seen = config;
      return content.includes('piege.xyz') ? { matched: true as const, domain: 'piege.xyz', pattern: 'custom_domain' } : { matched: false as const };
    }) as never;
    const rule = compileRule(parseSimulatedRule({ kind: 'scam', whitelist: ['Ok.fr'], customDomains: ['piege.xyz'] }), { config: null, detect });
    expect(rule.test(msg('va sur https://piege.xyz/claim'))).toEqual({ detail: 'Domaine suspect : piege.xyz', highlights: [[15, 24]] });
    expect(seen).toMatchObject({ scamFilterWhitelist: ['ok.fr'], scamFilterCustomDomains: ['piege.xyz'] });
    expect(rule.test(msg('rien'))).toBeNull();
  });
});

describe('anti-spam', () => {
  test('signale les messages au-delà de la limite dans la fenêtre', () => {
    const rule = parseSimulatedRule({ kind: 'spam', limit: 3, intervalSeconds: 5 });
    if (rule.kind !== 'spam') throw new Error('type');
    const burst = [0, 1000, 2000, 3000, 4000].map((at) => msg('x', { at, authorId: 'spam' }));
    const calm = [0, 10_000, 20_000, 30_000].map((at) => msg('x', { at, authorId: 'calme' }));
    const all = [...burst, ...calm].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const matches = findSpamBursts(all, rule);
    expect([...matches.keys()]).toEqual([burst[3].messageId, burst[4].messageId]);
  });
});

describe('validation', () => {
  test('refuse les règles inutilisables', () => {
    expect(() => parseSimulatedRule({ kind: 'keywords', keywords: [] })).toThrow(RuleSimulationError);
    expect(() => parseSimulatedRule({ kind: 'regex', pattern: '(' })).toThrow(RuleSimulationError);
    expect(() => parseSimulatedRule({ kind: 'regex', pattern: '(a+)+$' })).toThrow(RuleSimulationError);
    expect(() => parseSimulatedRule({ kind: 'inconnu' })).toThrow(RuleSimulationError);
  });

  test('borne les seuils numériques', () => {
    expect(parseSimulatedRule({ kind: 'caps', thresholdPercent: 5, minLength: 'x' })).toEqual({ kind: 'caps', thresholdPercent: 20, minLength: 10 });
  });
});

describe('indices de faux positif', () => {
  const match = (start: number, end: number) => ({ detail: '', highlights: [[start, end]] as Array<[number, number]> });

  test('staff, code et citation', () => {
    const m = msg('rien');
    expect(falsePositiveHint(m, match(0, 4), true)).toBe('Écrit par un membre du staff');
    expect(falsePositiveHint(msg('voir `con` ici'), match(6, 9), false)).toBe('Dans un bloc de code');
    expect(falsePositiveHint(msg('> quel con'), match(7, 10), false)).toBe('Dans une citation');
    expect(falsePositiveHint(msg('quel con'), match(5, 8), false)).toBeNull();
  });
});
