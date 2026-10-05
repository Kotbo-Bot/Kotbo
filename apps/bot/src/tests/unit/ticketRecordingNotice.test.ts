import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_NOTICE_TEXT,
  beginTicketOpening,
  buildNoticeEmbed,
  endTicketOpening,
  noticeSeconds,
  showRecordingNotice,
} from '../../services/features/ticketRecordingNotice.js';

const settings = (overrides: Partial<{ ticketRecordingNoticeEnabled: boolean; ticketRecordingNoticeSeconds: number; ticketRecordingNoticeText: string | null }> = {}) => ({
  ticketRecordingNoticeEnabled: true,
  ticketRecordingNoticeSeconds: 10,
  ticketRecordingNoticeText: null,
  ...overrides,
});

describe("avertissement d'enregistrement", () => {
  test('délai de lecture borné entre 5 et 30 secondes', () => {
    expect(noticeSeconds(10)).toBe(10);
    expect(noticeSeconds(2)).toBe(5);
    expect(noticeSeconds(120)).toBe(30);
    expect(noticeSeconds('abc')).toBe(10);
  });

  test('le texte par défaut parle de transcription à la fermeture, pas à la suppression', () => {
    expect(DEFAULT_NOTICE_TEXT).toContain('**fermeture**');
    expect(DEFAULT_NOTICE_TEXT).not.toContain('suppression');
  });

  test('encadré bleu avec compte à rebours Discord', () => {
    const embed = buildNoticeEmbed(settings(), new Date(1_700_000_010_000)).toJSON();
    expect(embed.color).toBe(0x5865f2);
    expect(embed.description).toContain('<t:1700000010:R>');
    expect(buildNoticeEmbed(settings({ ticketRecordingNoticeText: 'Texte maison' }), new Date()).toJSON().description).toContain('Texte maison');
  });

  test('montre le message, puis attend le délai avant de rendre la main', async () => {
    const edits: unknown[] = [];
    const waits: number[] = [];
    const interaction = { editReply: async (payload: unknown) => { edits.push(payload); } } as never;
    await showRecordingNotice(interaction, settings({ ticketRecordingNoticeSeconds: 15 }), async (ms) => { waits.push(ms); });
    expect(edits).toHaveLength(1);
    expect(waits).toEqual([15_000]);
  });

  test('désactivé : aucun message, aucune attente', async () => {
    const edits: unknown[] = [];
    const interaction = { editReply: async (payload: unknown) => { edits.push(payload); } } as never;
    await showRecordingNotice(interaction, settings({ ticketRecordingNoticeEnabled: false }), async () => { throw new Error('attente inattendue'); });
    expect(edits).toHaveLength(0);
  });

  test('un second clic pendant la lecture est refusé', () => {
    expect(beginTicketOpening('g', 'u')).toBe(true);
    expect(beginTicketOpening('g', 'u')).toBe(false);
    expect(beginTicketOpening('g', 'autre')).toBe(true);
    endTicketOpening('g', 'u');
    endTicketOpening('g', 'autre');
    expect(beginTicketOpening('g', 'u')).toBe(true);
    endTicketOpening('g', 'u');
  });
});
