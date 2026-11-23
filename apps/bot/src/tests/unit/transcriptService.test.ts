import { describe, expect, test } from 'bun:test';
import { stripLegacyAvatarBackground } from '../../services/features/transcriptService';

describe('stripLegacyAvatarBackground', () => {
  test("retire le fond bleu sous l'avatar des anciennes transcriptions", () => {
    const legacy = `<style>
    .avatar {
      width: 40px;
      border-radius: 50%;
      background-color: #5865F2;
      flex-shrink: 0;
    }
    .bot-tag {
      background-color: #5865f2;
    }
  </style>`;
    const patched = stripLegacyAvatarBackground(legacy);
    expect(patched).not.toMatch(/\.avatar\s*\{[^}]*background-color/);
    expect(patched).toContain('flex-shrink: 0;');
    // Le badge BOT garde sa couleur.
    expect(patched).toMatch(/\.bot-tag\s*\{\s*background-color: #5865f2;/);
  });

  test('laisse intact un HTML déjà corrigé', () => {
    const html = '<style>.avatar { width: 40px; flex-shrink: 0; }</style>';
    expect(stripLegacyAvatarBackground(html)).toBe(html);
  });
});
