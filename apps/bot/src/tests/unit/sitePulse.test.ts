/**
 * Pouls du site : humeur du serveur, courbe des 24 heures, habitude d'une heure.
 */
import { describe, expect, test } from 'bun:test';
// Chargé d'abord, comme en production : les blocs se référencent entre eux par le rendu.
import '../../services/site/sitePages.js';
import { computePulseMood, renderDayChart, renderPulseInner, summarizeHourly, type PulseData } from '../../services/site/sitePulse.js';

const hour = (date: Date, messages: number, joins = 0) => ({ dateKey: date.toISOString().slice(0, 10), hour: date.getUTCHours(), messages, joins });

describe('humeur du serveur', () => {
  test('silence, activité sans habitude connue, puis comparaison', () => {
    expect(computePulseMood(0, 40)).toEqual({ level: 'quiet', ratio: null });
    expect(computePulseMood(12, null)).toEqual({ level: 'active', ratio: null });
    expect(computePulseMood(12, 2)).toEqual({ level: 'active', ratio: null });
    expect(computePulseMood(10, 40).level).toBe('calm');
    expect(computePulseMood(40, 40)).toEqual({ level: 'usual', ratio: 1 });
    expect(computePulseMood(70, 40).level).toBe('busy');
    expect(computePulseMood(120, 40)).toEqual({ level: 'peak', ratio: 3 });
  });
});

describe('statistiques horaires', () => {
  const now = new Date('2026-10-11T18:20:00Z');

  test('24 barres, la plus ancienne d’abord, heure en cours en dernier', () => {
    const rows = [hour(now, 30, 2), hour(new Date(now.getTime() - 3_600_000), 10, 1), hour(new Date(now.getTime() - 24 * 3_600_000), 99, 7)];
    const { day, joins24h } = summarizeHourly(rows, now);
    expect(day).toHaveLength(24);
    expect(day[23]).toBe(30);
    expect(day[22]).toBe(10);
    // L'heure d'il y a 24 h sort de la fenêtre.
    expect(day.reduce((a, b) => a + b, 0)).toBe(40);
    expect(joins24h).toBe(3);
  });

  test('habitude : moyenne des mêmes heures, jours muets compris, pas avant le premier jour connu', () => {
    const rows = [1, 2, 4].map((d) => hour(new Date(now.getTime() - d * 86_400_000), 30));
    // Jours 1 à 4 couverts (le 4e est le plus ancien) : 30 + 30 + 0 + 30, sur 4.
    expect(summarizeHourly(rows, now).baseline).toBe(22.5);
    // Deux jours d'historique seulement : pas d'habitude.
    expect(summarizeHourly(rows.slice(0, 2), now).baseline).toBeNull();
    expect(summarizeHourly([], now).baseline).toBeNull();
  });
});

describe('rendu', () => {
  test('courbe vide sans message, barre courante marquée sinon', () => {
    expect(renderDayChart(new Array(24).fill(0), 'fr')).toBe('');
    const svg = renderDayChart([...new Array(23).fill(1), 5], 'fr');
    expect(svg.match(/<rect/g)).toHaveLength(24);
    expect(svg).toContain('pulse-bar-now');
  });

  test('noms de salons échappés, chiffres animables', () => {
    const pulse: PulseData = {
      at: '2026-10-11T18:20:00Z',
      online: 1200,
      members: 5000,
      voice: { total: 3, rooms: [{ id: '1', name: 'Salon <b>', count: 3, faces: [{ name: 'Ana', avatar: null }] }] },
      live: { messages: 84, authors: 20, perMinute: 2.8 },
      hot: [{ id: '2', name: 'général"><script>', messages: 60 }],
      day: new Array(24).fill(2),
      joins24h: 9,
      mood: { level: 'busy', ratio: 1.8 },
      next: { title: 'Tournoi', startsAt: '2026-10-11T20:00:00Z', live: false },
    };
    const html = renderPulseInner(pulse, 'fr');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('Salon <b>');
    expect(html).toContain('data-count="1200"');
    expect(html).toContain('data-prefix="+"');
    expect(html).toContain('data-countdown="2026-10-11T20:00:00Z"');
    expect(html).toContain('pulse-mood-busy');
  });
});
