import { describe, expect, test } from 'bun:test';
import { DEFAULT_ALERT_EVENTS, WELLBEING_ALERT_EVENTS, alertText } from '../../services/staff/wellbeingAlertPolicy';
import {
  CRISIS_PROTOCOL_TASKS,
  CRISIS_REVIEW_HOURS,
  crisisProtocolDue,
  crisisTaskDrafts,
  followUpDate,
  ticketCaseSummary,
} from '../../services/staff/wellbeingCasePolicy';
import {
  MAX_REPORTER_MESSAGES,
  REPORT_PANEL_TEMPLATES,
  cleanPanelTemplate,
  cleanResources,
  reporterCanWrite,
  resourcesForLocale,
  trackingThread,
} from '../../services/staff/wellbeingReportPolicy';
import {
  REFERENT_OVERLOAD_ACTIVE,
  referentLoad,
  suggestAssignee,
  weeklyDigestText,
  weeklyDue,
} from '../../services/staff/wellbeingWorkloadPolicy';
import {
  DISTRESS_COOLDOWN_MS,
  PULSE_MIN_RESPONSES,
  cleanPulseScore,
  detectDistress,
  pulseSummary,
  pulseVoterHash,
  pulseWeekKey,
  shouldSignalDistress,
} from '../../services/staff/wellbeingWatchPolicy';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-11-25T12:00:00Z');

describe('protocole de crise', () => {
  test("s'applique quand un dossier devient critique, une seule fois", () => {
    expect(crisisProtocolDue(null, 'CRITICAL', { enabled: true, applied: false })).toBe(true);
    expect(crisisProtocolDue('HIGH', 'CRITICAL', { enabled: true, applied: false })).toBe(true);
    expect(crisisProtocolDue('CRITICAL', 'CRITICAL', { enabled: true, applied: false })).toBe(false);
    expect(crisisProtocolDue('HIGH', 'CRITICAL', { enabled: true, applied: true })).toBe(false);
    expect(crisisProtocolDue(null, 'HIGH', { enabled: true, applied: false })).toBe(false);
  });

  test('reste coupé si la cellule ne le veut pas', () => {
    expect(crisisProtocolDue(null, 'CRITICAL', { enabled: false, applied: false })).toBe(false);
  });

  test('chaque étape a une échéance, la première dans la journée', () => {
    const drafts = crisisTaskDrafts(NOW);
    expect(drafts).toHaveLength(CRISIS_PROTOCOL_TASKS.length);
    expect(drafts[0]!.dueAt.getTime() - NOW.getTime()).toBeLessThanOrEqual(DAY);
    for (const draft of drafts) {
      expect(draft.label.length).toBeGreaterThan(0);
      expect(draft.dueAt.getTime()).toBeGreaterThan(NOW.getTime());
    }
    expect(CRISIS_REVIEW_HOURS).toBe(48);
  });
});

describe('ressources par langue', () => {
  const resources = cleanResources([
    { label: '3114', phone: '3114', locale: 'fr' },
    { label: '988 Lifeline', phone: '988', locale: 'en' },
    { label: 'Charte du serveur', url: 'https://example.org' },
    { label: 'Inconnue', locale: 'français' },
  ]);

  test('une langue invalide est retirée, la ressource reste pour tous', () => {
    expect(resources.map((r) => r.locale)).toEqual(['fr', 'en', null, null]);
  });

  test('un membre voit les ressources de sa langue et celles pour tous', () => {
    expect(resourcesForLocale(resources, 'fr').map((r) => r.label)).toEqual(['3114', 'Charte du serveur', 'Inconnue']);
    expect(resourcesForLocale(resources, 'en-US').map((r) => r.label)).toEqual(['988 Lifeline', 'Charte du serveur', 'Inconnue']);
  });

  test('sans rien pour sa langue, il voit tout plutôt que rien', () => {
    const onlyFr = cleanResources([{ label: '3114', phone: '3114', locale: 'fr' }]);
    expect(resourcesForLocale(onlyFr, 'de').map((r) => r.label)).toEqual(['3114']);
  });
});

describe('prise de nouvelles après clôture', () => {
  test('un dossier résolu est rappelé après le délai choisi', () => {
    expect(followUpDate(NOW, 30, 'RESOLVED')?.getTime()).toBe(NOW.getTime() + 30 * DAY);
  });

  test("ni un autre motif, ni un délai nul, ne programment de rappel", () => {
    expect(followUpDate(NOW, 30, 'REFERRED')).toBeNull();
    expect(followUpDate(NOW, 30, null)).toBeNull();
    expect(followUpDate(NOW, 0, 'RESOLVED')).toBeNull();
  });

  test("le rappel ne dit rien du dossier", () => {
    const text = alertText('REMINDER', { actorId: '', reminder: 'follow_up', days: 30 });
    expect(text).toContain('30');
    expect(text).toContain('nouvelles');
  });
});

describe('fil anonyme avec le signaleur', () => {
  test("le signaleur n'écrit plus sur un dossier fermé ou supprimé, ni au-delà de la limite", () => {
    expect(reporterCanWrite({ status: 'OPEN', deletedAt: null }, 0)).toBe(true);
    expect(reporterCanWrite({ status: 'CLOSED', deletedAt: null }, 0)).toBe(false);
    expect(reporterCanWrite({ status: 'OPEN', deletedAt: NOW }, 0)).toBe(false);
    expect(reporterCanWrite({ status: 'OPEN', deletedAt: null }, MAX_REPORTER_MESSAGES)).toBe(false);
  });

  test('le suivi montre les derniers échanges, du plus ancien au plus récent', () => {
    const messages = Array.from({ length: 8 }, (_, i) => ({ fromReporter: i % 2 === 0, content: `m${i}`, createdAt: new Date(NOW.getTime() + i) }));
    expect(trackingThread(messages, 3).map((msg) => msg.content)).toEqual(['m5', 'm6', 'm7']);
  });

  test("l'alerte d'un nouveau message ne nomme personne", () => {
    const text = alertText('REPORT', { actorId: '', followUp: true });
    expect(text).not.toContain('<@');
    expect(text).toContain('message');
  });
});

describe('modèles du message permanent', () => {
  test('un modèle connu est gardé', () => {
    for (const template of REPORT_PANEL_TEMPLATES) expect(cleanPanelTemplate(template)).toBe(template);
  });

  test('un modèle inconnu ou absent devient le modèle par défaut', () => {
    expect(cleanPanelTemplate('inconnu')).toBe('listening');
    expect(cleanPanelTemplate(undefined)).toBe('listening');
    expect(cleanPanelTemplate(3)).toBe('listening');
  });

  test('le modèle par défaut vient en premier', () => {
    expect(REPORT_PANEL_TEMPLATES[0]).toBe('listening');
  });
});

describe('transfert d’un ticket', () => {
  test('le résumé reprend le motif et la description, dans la limite', () => {
    const summary = ticketCaseSummary({ reason: 'Harcèlement', description: 'x'.repeat(5000), ticketTypeLabel: 'Aide', username: 'alice' });
    expect(summary.startsWith('Ticket « Aide » ouvert par alice')).toBe(true);
    expect(summary).toContain('Harcèlement');
    expect(summary.length).toBeLessThanOrEqual(4000);
  });
});

describe('mots de détresse', () => {
  test('repère les formulations courantes, accents et majuscules compris', () => {
    expect(detectDistress("J'ai ENVIE DE MOURIR ce soir")).toBe(true);
    expect(detectDistress('je pense à me suicider')).toBe(true);
    expect(detectDistress('i want to kill myself')).toBe(true);
    expect(detectDistress("j'ai plus envie de vivre")).toBe(true);
    expect(detectDistress('j’ai envie d’en finir')).toBe(true);
  });

  test("ignore les phrases anodines qui s'en approchent", () => {
    expect(detectDistress('ce boss va me tuer de rire')).toBe(false);
    expect(detectDistress('je vais mourir de rire')).toBe(false);
    expect(detectDistress("j'ai envie de mourir de rire")).toBe(false);
    expect(detectDistress('on va en finir avec ce boss')).toBe(false);
    expect(detectDistress('ça va me faire du mal au portefeuille')).toBe(false);
    expect(detectDistress("I'm going to die in this raid")).toBe(false);
    expect(detectDistress('I hurt myself playing football')).toBe(false);
    expect(detectDistress('on a fini la quête')).toBe(false);
    expect(detectDistress('')).toBe(false);
  });

  test('un même membre ne déclenche qu’un signal par jour', () => {
    expect(shouldSignalDistress(undefined, NOW.getTime())).toBe(true);
    expect(shouldSignalDistress(NOW.getTime() - DISTRESS_COOLDOWN_MS + 1, NOW.getTime())).toBe(false);
    expect(shouldSignalDistress(NOW.getTime() - DISTRESS_COOLDOWN_MS, NOW.getTime())).toBe(true);
  });

  test("l'alerte est cochée par défaut et ne nomme pas le membre", () => {
    expect(WELLBEING_ALERT_EVENTS).toContain('DISTRESS');
    expect(DEFAULT_ALERT_EVENTS).toContain('DISTRESS');
    const text = alertText('DISTRESS', { actorId: '200000000000000001' });
    expect(text).not.toContain('<@');
  });

  test("l'alerte de sanction ne dit ni qui ni pourquoi", () => {
    const text = alertText('SANCTION_SIGNAL', { actorId: '200000000000000001' });
    expect(text).toContain('<@200000000000000001>');
    expect(text).not.toContain('dossier de');
  });
});

describe('charge des référents', () => {
  const cases = [
    ...Array.from({ length: REFERENT_OVERLOAD_ACTIVE }, () => ({ status: 'OPEN', severity: 'NORMAL', assigneeId: 'a' })),
    { status: 'OPEN', severity: 'CRITICAL', assigneeId: 'b' },
    { status: 'CLOSED', severity: 'CRITICAL', assigneeId: 'b' },
    { status: 'OPEN', severity: 'LOW', assigneeId: null },
  ];

  test('compte les dossiers actifs de chaque membre, ceux sans dossier compris', () => {
    const load = referentLoad(cases, ['a', 'b', 'c']);
    expect(load).toEqual([
      { userId: 'a', active: REFERENT_OVERLOAD_ACTIVE, critical: 0, overloaded: true },
      { userId: 'b', active: 1, critical: 1, overloaded: false },
      { userId: 'c', active: 0, critical: 0, overloaded: false },
    ]);
  });

  test('propose le membre le moins chargé, hors personnes écartées', () => {
    const load = referentLoad(cases, ['a', 'b', 'c']);
    expect(suggestAssignee(load, [])).toBe('c');
    expect(suggestAssignee(load, ['c'])).toBe('b');
    expect(suggestAssignee(load.filter((l) => l.userId === 'a'), [])).toBeNull();
  });

  test('le résumé du lundi prévient un référent surchargé', () => {
    const text = weeklyDigestText('Serveur', { assigned: REFERENT_OVERLOAD_ACTIVE, reviewsThisWeek: 0, triage: 0, criticalUnassigned: 0 });
    expect(text).toContain('collègue');
    const calm = weeklyDigestText('Serveur', { assigned: 1, reviewsThisWeek: 0, triage: 0, criticalUnassigned: 0 });
    expect(calm).not.toContain('collègue');
  });
});

describe('météo du staff', () => {
  test('la semaine suit la norme ISO', () => {
    expect(pulseWeekKey(new Date('2026-11-25T12:00:00Z'))).toBe('2026-W48');
    expect(pulseWeekKey(new Date('2027-01-01T12:00:00Z'))).toBe('2026-W53');
    expect(pulseWeekKey(new Date('2026-01-01T12:00:00Z'))).toBe('2026-W01');
  });

  test('le sondage part le lundi à partir de l’heure prévue, une fois par semaine', () => {
    const monday = new Date('2026-11-23T10:00:00Z');
    expect(weeklyDue(null, monday, 10)).toBe(true);
    expect(weeklyDue(null, new Date('2026-11-23T09:00:00Z'), 10)).toBe(false);
    expect(weeklyDue(null, new Date('2026-11-24T10:00:00Z'), 10)).toBe(false);
    expect(weeklyDue(new Date(monday.getTime() - HOUR), monday, 10)).toBe(false);
  });

  test('seule une note de 1 à 5 est acceptée', () => {
    expect(cleanPulseScore('3')).toBe(3);
    expect(cleanPulseScore('0')).toBeNull();
    expect(cleanPulseScore('6')).toBeNull();
    expect(cleanPulseScore('x')).toBeNull();
  });

  test("l'empreinte du votant dépend du serveur et de la semaine", () => {
    const a = pulseVoterHash('g1', '2026-W48', 'u1');
    expect(a).toBe(pulseVoterHash('g1', '2026-W48', 'u1'));
    expect(a).not.toBe(pulseVoterHash('g1', '2026-W49', 'u1'));
    expect(a).not.toBe(pulseVoterHash('g2', '2026-W48', 'u1'));
    expect(a).not.toContain('u1');
  });

  test('une semaine sans assez de réponses ne montre pas de moyenne', () => {
    const summary = pulseSummary([
      { week: '2026-W47', score1: 0, score2: 1, score3: 1, score4: 1, score5: 0 },
      { week: '2026-W48', score1: 1, score2: 0, score3: 0, score4: 3, score5: 1 },
    ]);
    expect(PULSE_MIN_RESPONSES).toBe(5);
    expect(summary).toEqual([
      { week: '2026-W47', responses: 3, average: null },
      { week: '2026-W48', responses: 5, average: 3.6 },
    ]);
  });
});

describe('signal aux modérateurs', () => {
  test('le message au modérateur ne dit rien du dossier', async () => {
    const { sanctionModeratorText } = await import('../../services/staff/wellbeingWatchPolicy');
    const text = sanctionModeratorText();
    expect(text).toContain('cellule');
    expect(text).not.toContain('<@');
  });
});

describe('anonymat de la commande de la cellule', () => {
  test("le journal des commandes n'inscrit pas /confidentiel ni ses arguments", async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(join(import.meta.dir, '../../index.ts'), 'utf-8');
    const auditBlock = source.slice(source.lastIndexOf('if (', source.indexOf('interaction.options.data.map')), source.indexOf('interaction.options.data.map'));
    expect(auditBlock).toContain('interaction.commandName !== WELLBEING_COMMAND');
  });
});
