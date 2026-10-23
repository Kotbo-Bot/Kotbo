import { describe, expect, test } from 'bun:test';
import {
  clampScore,
  computeActivityScore,
  computeEngagementScore,
  computeGrowthScore,
  computeHealthScore,
  computeModerationScore,
  computePulseBreakdown,
  computePulseScores,
  generateAlerts,
  hasEnoughSignal,
  median,
  percentileRank,
  resolveTrend,
  saturate,
  saturateInverse,
  sizeFactor,
  trendAgainst,
  type PulseScoreInput,
} from '../../services/analytics/pulseScoring.js';

function input(overrides: Partial<PulseScoreInput> = {}): PulseScoreInput {
  return {
    humans: 100,
    totalMembers: 110,
    messages: 200,
    voiceMinutes: 400,
    activeMembers: 20,
    activeVoiceMembers: 6,
    membersJoined: 2,
    membersLeft: 1,
    sanctionsCount: 0,
    ticketsOpen: 1,
    ticketsResolved: 3,
    channelsHealthy: 18,
    channelsUnhealthy: 2,
    baseline: null,
    ...overrides,
  };
}

describe('primitives', () => {
  test('saturate vaut 50 au point de calibration et reste borné', () => {
    expect(saturate(5, 5)).toBeCloseTo(50, 6);
    expect(saturate(0, 5)).toBe(0);
    expect(saturate(-3, 5)).toBe(0);
    expect(saturate(1e9, 5)).toBeLessThan(100);
    expect(saturate(1e9, 5)).toBeGreaterThan(99);
  });

  test('saturate est strictement croissante', () => {
    let previous = -1;
    for (let x = 0; x <= 20; x += 0.5) {
      const value = saturate(x, 4);
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
  });

  test('saturateInverse est le miroir de saturate', () => {
    expect(saturateInverse(0, 5)).toBe(100);
    expect(saturateInverse(5, 5)).toBeCloseTo(50, 6);
    expect(saturateInverse(50, 5)).toBeLessThan(10);
  });

  test('clampScore neutralise NaN et Infinity', () => {
    expect(clampScore(Number.NaN)).toBe(0);
    expect(clampScore(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampScore(140)).toBe(100);
    expect(clampScore(-40)).toBe(0);
  });

  test('median tolère les échantillons pairs, impairs et vides', () => {
    expect(median([])).toBe(0);
    expect(median([5])).toBe(5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('sous-scores', () => {
  test('un serveur sans humains ne produit pas de score fantaisiste', () => {
    const empty = input({ humans: 0, totalMembers: 0, messages: 0, voiceMinutes: 0, activeMembers: 0 });
    expect(computeActivityScore(empty)).toBe(0);
    expect(computeEngagementScore(empty)).toBe(0);
    // Croissance et modération restent neutres : il n'y a rien à juger.
    expect(computeGrowthScore(empty)).toBe(50);
    expect(computeModerationScore(empty)).toBe(75);
  });

  test("l'activité est rapportée aux humains, pas à l'effectif total", () => {
    const withBots = computeActivityScore(input({ humans: 50, totalMembers: 200, messages: 100 }));
    const withoutBots = computeActivityScore(input({ humans: 200, totalMembers: 200, messages: 100 }));
    expect(withBots).toBeGreaterThan(withoutBots);
  });

  test('la modération décroît continûment, sans palier', () => {
    const scores = [0, 1, 2, 3, 4, 5].map((n) =>
      computeModerationScore(input({ sanctionsCount: n, activeMembers: 50 })),
    );
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
      // Aucune marche de plus de 20 points, contrairement aux anciens seuils.
      expect(scores[i - 1] - scores[i]).toBeLessThan(20);
    }
  });

  test('la croissance est symétrique autour de zéro', () => {
    const flat = computeGrowthScore(input({ membersJoined: 0, membersLeft: 0 }));
    expect(flat).toBe(50);
    expect(computeGrowthScore(input({ membersJoined: 5, membersLeft: 0 }))).toBeGreaterThan(flat);
    expect(computeGrowthScore(input({ membersJoined: 0, membersLeft: 5 }))).toBeLessThan(flat);
  });

  test('une porte tournante est moins bien notée qu’une croissance nette identique', () => {
    // Même solde net (+0), mais l'un brasse 10 membres et l'autre aucun.
    const churning = computeGrowthScore(input({ membersJoined: 10, membersLeft: 10 }));
    const stable = computeGrowthScore(input({ membersJoined: 0, membersLeft: 0 }));
    expect(churning).toBeLessThan(stable);
  });

  test('le backlog de tickets pèse sur la santé indépendamment du taux de résolution', () => {
    const small = computeHealthScore(input({ ticketsOpen: 1, ticketsResolved: 3 }));
    const large = computeHealthScore(input({ ticketsOpen: 40, ticketsResolved: 120 }));
    expect(large).toBeLessThan(small);
  });
});

describe('référence interne au serveur', () => {
  const baseline = {
    messagesPerHuman: 2,
    voicePerHuman: 4,
    participationRate: 0.2,
    sampleDays: 28,
  };

  test('une journée conforme à la norme du serveur est mieux notée qu’une journée creuse', () => {
    const normal = computeActivityScore(input({ humans: 100, messages: 200, baseline }));
    const quiet = computeActivityScore(input({ humans: 100, messages: 20, baseline }));
    expect(normal).toBeGreaterThan(quiet);
  });

  test('une référence trop courte est ignorée', () => {
    const short = { ...baseline, sampleDays: 3 };
    const withShort = computeActivityScore(input({ messages: 20, baseline: short }));
    const without = computeActivityScore(input({ messages: 20, baseline: null }));
    expect(withShort).toBe(without);
  });
});

describe('score global', () => {
  test('reste dans [0, 100] sur des entrées extrêmes', () => {
    const extremes: PulseScoreInput[] = [
      input({ humans: 1, messages: 1e6, voiceMinutes: 1e6, activeMembers: 1 }),
      input({ humans: 1e6, messages: 0, voiceMinutes: 0, activeMembers: 0, membersLeft: 1e5 }),
      input({ humans: 0, totalMembers: 0 }),
      input({ sanctionsCount: 1e4, ticketsOpen: 1e4 }),
    ];
    for (const candidate of extremes) {
      const scores = computePulseScores(candidate);
      for (const value of Object.values(scores)) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(100);
        expect(Number.isInteger(value)).toBe(true);
      }
    }
  });

  test('un serveur sain est mieux noté qu’un serveur en difficulté', () => {
    const healthy = computePulseScores(
      input({ messages: 800, activeMembers: 45, activeVoiceMembers: 20, membersJoined: 6, membersLeft: 1 }),
    );
    const struggling = computePulseScores(
      input({ messages: 5, activeMembers: 2, activeVoiceMembers: 0, membersJoined: 0, membersLeft: 12, sanctionsCount: 4 }),
    );
    expect(healthy.score).toBeGreaterThan(struggling.score);
  });
});

describe('alertes', () => {
  test('un serveur sans matière ne reçoit qu’une alerte « données insuffisantes »', () => {
    const fresh = input({ humans: 2, messages: 0, voiceMinutes: 0, membersJoined: 0, activeMembers: 0 });
    expect(hasEnoughSignal(fresh)).toBe(false);

    const alerts = generateAlerts(computePulseScores(fresh), fresh);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].code).toBe('insufficient_data');
  });

  test('chaque alerte porte un code stable et ses paramètres', () => {
    const struggling = input({ ticketsOpen: 25, messages: 3, activeMembers: 2, membersLeft: 15, membersJoined: 0 });
    const alerts = generateAlerts(computePulseScores(struggling), struggling);

    expect(alerts.length).toBeGreaterThan(0);
    for (const alert of alerts) {
      expect(alert.code).toBeTruthy();
      expect(alert.message).toBeTruthy();
      expect(['info', 'warning', 'danger', 'success']).toContain(alert.severity);
    }

    const backlog = alerts.find((a) => a.code === 'tickets_backlog');
    expect(backlog?.params?.count).toBe(25);
  });

  test('un serveur en pleine forme reçoit l’alerte positive', () => {
    const thriving = input({
      humans: 100,
      messages: 1500,
      voiceMinutes: 3000,
      activeMembers: 60,
      activeVoiceMembers: 30,
      membersJoined: 8,
      membersLeft: 0,
      sanctionsCount: 0,
      ticketsOpen: 0,
      ticketsResolved: 5,
      channelsHealthy: 20,
      channelsUnhealthy: 0,
    });
    const alerts = generateAlerts(computePulseScores(thriving), thriving);
    expect(alerts.some((a) => a.code === 'excellent')).toBe(true);
  });
});

describe('tendance', () => {
  test('ne bascule qu’au-delà du seuil de bruit', () => {
    expect(resolveTrend(0)).toBe('STABLE');
    expect(resolveTrend(3)).toBe('STABLE');
    expect(resolveTrend(-3)).toBe('STABLE');
    expect(resolveTrend(4)).toBe('UP');
    expect(resolveTrend(-4)).toBe('DOWN');
  });

  test('se mesure face à la médiane de la semaine, pas face à la seule veille', () => {
    // Veille exceptionnellement basse : la journée n'est pas « en hausse » pour autant.
    expect(trendAgainst(70, [40, 70, 71, 69, 70, 72, 70])).toEqual({ trend: 'STABLE', delta: 0 });
    expect(trendAgainst(60, [70, 71, 69])).toEqual({ trend: 'DOWN', delta: -10 });
    expect(trendAgainst(60, [])).toEqual({ trend: 'STABLE', delta: 0 });
  });
});

describe('modèle v3', () => {
  const baseline = { messagesPerHuman: 2, voicePerHuman: 4, participationRate: 0.2, sampleDays: 28 };

  test('un jour se compare aux mêmes jours de semaine quand il y en a assez', () => {
    // Le mardi est calme d'habitude : 50 messages un mardi, c'est la norme.
    const sameWeekday = { messagesPerHuman: 0.5, voicePerHuman: 4, participationRate: 0.2, samples: 4 };
    const quietTuesday = input({ messages: 50, baseline: { ...baseline, sameWeekday } });
    const asAnyDay = input({ messages: 50, baseline });
    expect(computeActivityScore(quietTuesday)).toBeGreaterThan(computeActivityScore(asAnyDay));
    // Trop peu de mardis observés : on retombe sur tous les jours.
    const fewSamples = input({ messages: 50, baseline: { ...baseline, sameWeekday: { ...sameWeekday, samples: 2 } } });
    expect(computeActivityScore(fewSamples)).toBe(computeActivityScore(asAnyDay));
  });

  test('les repères absolus suivent la taille du serveur', () => {
    expect(sizeFactor(100)).toBeCloseTo(1, 6);
    expect(sizeFactor(1000)).toBeLessThan(1);
    expect(sizeFactor(10)).toBeGreaterThan(1);
    // 6 % d'actifs : faible sur 100 humains, honorable sur 5 000.
    const small = computeEngagementScore(input({ humans: 100, activeMembers: 6, messages: 48 }));
    const large = computeEngagementScore(input({ humans: 5000, activeMembers: 300, messages: 2400 }));
    expect(large).toBeGreaterThan(small);
  });

  test('un serveur sans vocal n’est pas pénalisé pour son absence', () => {
    const noVoice = input({ voiceMinutes: 0, activeVoiceMembers: 0, baseline: { ...baseline, voicePerHuman: 0 } });
    const factors = computePulseBreakdown(noVoice).factors.map((f) => f.key);
    expect(factors).not.toContain('voice');
    expect(factors).not.toContain('voiceParticipation');
    // Le vocal habituel qui disparaît, lui, se voit.
    const voiceStopped = input({ voiceMinutes: 0, activeVoiceMembers: 0, baseline });
    expect(computePulseBreakdown(voiceStopped).factors.map((f) => f.key)).toContain('voice');
  });

  test('les messages sans réponse et la toxicité pèsent sur leur sous-score', () => {
    const answered = computeEngagementScore(input({ responses: { answered: 90, unanswered: 10, fast: 70 } }));
    const ignored = computeEngagementScore(input({ responses: { answered: 10, unanswered: 90, fast: 5 } }));
    expect(answered).toBeGreaterThan(ignored);

    const calm = computeModerationScore(input({ activeMembers: 50, toxicity: { analyzed: 400, toxic: 4 } }));
    const tense = computeModerationScore(input({ activeMembers: 50, toxicity: { analyzed: 400, toxic: 80 } }));
    expect(calm).toBeGreaterThan(tense);
    // Échantillon trop petit : pas de facteur.
    const tiny = computePulseBreakdown(input({ toxicity: { analyzed: 5, toxic: 5 } }));
    expect(tiny.factors.some((f) => f.key === 'toxicity')).toBe(false);
  });

  test('l’adhérence DAU/MAU récompense les membres qui reviennent', () => {
    const loyal = computeEngagementScore(input({ audience: { daily: 30, monthly: 60 } }));
    const passing = computeEngagementScore(input({ audience: { daily: 30, monthly: 600 } }));
    expect(loyal).toBeGreaterThan(passing);
  });

  test('la croissance lisse un jour isolé avec la semaine', () => {
    // Même journée à 6 départs, mais l'une s'inscrit dans une semaine calme.
    const isolated = computeGrowthScore(input({ membersJoined: 0, membersLeft: 6, week: { joined: 7, left: 7, days: 7 } }));
    const raw = computeGrowthScore(input({ membersJoined: 0, membersLeft: 6 }));
    expect(isolated).toBeGreaterThan(raw);
  });

  test('les impacts des facteurs expliquent l’écart du score à 50', () => {
    const candidate = input({
      baseline,
      audience: { daily: 20, monthly: 80 },
      responses: { answered: 40, unanswered: 20, fast: 30 },
      toxicity: { analyzed: 200, toxic: 6 },
      week: { joined: 10, left: 6, days: 7 },
    });
    const { scores, factors } = computePulseBreakdown(candidate);
    const explained = 50 + factors.reduce((sum, f) => sum + f.impact, 0);
    // Arrondis des facteurs : l'écart reste de l'ordre du point.
    expect(Math.abs(explained - scores.score)).toBeLessThan(2);
    for (const dimension of ['activity', 'engagement', 'growth', 'moderation', 'health'] as const) {
      const weights = factors.filter((f) => f.dimension === dimension).reduce((s, f) => s + f.weight, 0);
      expect(weights).toBeCloseTo(1, 2);
    }
  });

  test('la confiance croît avec le volume, l’historique et la couverture', () => {
    const thin = computePulseBreakdown(input({ humans: 8, activeMembers: 2, messages: 4 })).confidence;
    const rich = computePulseBreakdown(
      input({ humans: 400, activeMembers: 80, baseline, audience: { daily: 80, monthly: 200 }, responses: { answered: 50, unanswered: 10, fast: 40 } }),
    ).confidence;
    expect(rich).toBeGreaterThan(thin);
    expect(rich).toBeLessThanOrEqual(100);
    expect(thin).toBeGreaterThanOrEqual(0);
  });

  test('le rang centile exige assez de pairs et compte les ex æquo pour moitié', () => {
    expect(percentileRank(70, [10, 20, 30])).toBeNull();
    expect(percentileRank(70, [10, 20, 30, 40, 50, 60, 70, 80])).toBe(81);
    expect(percentileRank(0, Array(10).fill(50))).toBe(0);
    expect(percentileRank(100, Array(10).fill(50))).toBe(100);
  });

  test('les nouvelles alertes portent leur pourcentage', () => {
    const tense = input({ messages: 300, activeMembers: 30, toxicity: { analyzed: 300, toxic: 30 }, responses: { answered: 10, unanswered: 40, fast: 2 } });
    const alerts = generateAlerts(computePulseScores(tense), tense);
    expect(alerts.find((a) => a.code === 'toxicity_high')?.params?.pct).toBe(10);
    expect(alerts.find((a) => a.code === 'responses_low')?.params?.pct).toBe(80);
  });
});
