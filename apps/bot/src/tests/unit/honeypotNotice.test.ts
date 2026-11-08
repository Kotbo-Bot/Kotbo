import { describe, expect, it } from 'bun:test';
import { honeypotConsequence, honeypotNoticeEmbed } from '../../services/moderation/honeypotProvisioning.js';

const base = { honeypotSanction: 'TIMEOUT', honeypotDurationMin: null, honeypotGraceSeconds: 0, honeypotShowCount: false, honeypotCatchCount: 0 };

describe('avertissement du salon piège', () => {
  it('annonce la sanction réellement configurée', () => {
    expect(honeypotConsequence({ honeypotSanction: 'BAN', honeypotDurationMin: null })).toContain('définitif');
    expect(honeypotConsequence({ honeypotSanction: 'BAN', honeypotDurationMin: 1440 })).toContain('1 j');
    expect(honeypotConsequence({ honeypotSanction: 'KICK', honeypotDurationMin: null })).toContain('expulsion');
    expect(honeypotConsequence({ honeypotSanction: 'WARN', honeypotDurationMin: null })).toContain('avertissement');
    expect(honeypotConsequence({ honeypotSanction: 'JAIL', honeypotDurationMin: null })).toContain('quarantaine définitive');
    // Timeout sans durée : plafond Discord de 28 jours.
    expect(honeypotConsequence({ honeypotSanction: 'TIMEOUT', honeypotDurationMin: null })).toContain('28 j');
  });

  it("n'affiche le compteur que si l'option est active", () => {
    expect(honeypotNoticeEmbed({ ...base, honeypotCatchCount: 1715 }).data.fields).toBeUndefined();
    const fields = honeypotNoticeEmbed({ ...base, honeypotShowCount: true, honeypotCatchCount: 1715 }).data.fields;
    expect(fields?.[0]?.value.replace(/\s/g, '')).toBe('1715');
  });

  it('mentionne le délai pour signaler une erreur', () => {
    expect(honeypotNoticeEmbed({ ...base, honeypotGraceSeconds: 60 }).data.description).toContain('1 min');
  });
});
