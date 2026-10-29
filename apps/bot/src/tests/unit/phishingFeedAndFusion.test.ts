import { beforeEach, describe, expect, it } from 'bun:test';
import type { RaidProtectionConfig } from '@prisma/client';
import {
  checkDomainAgainstFeeds,
  detectLookalikeDomain,
  detectScam,
  seedPhishingFeedsForTests,
  visualSkeleton,
} from '../../services/moderation/phishingFeedService.js';
import { extractDomains } from '../../services/moderation/scamHeuristics.js';

function makeConfig(overrides: Partial<RaidProtectionConfig> = {}): RaidProtectionConfig {
  return {
    scamFilterCustomDomains: [],
    scamFilterWhitelist: [],
    ...overrides,
  } as RaidProtectionConfig;
}

describe('phishingFeedService & fusion Kotbo Vision', () => {
  beforeEach(() => {
    seedPhishingFeedsForTests(
      ['free-nitro-drop.ru', 'steam-gift-claim.xyz'],
      ['suspicious-airdrop.top']
    );
  });

  describe('Flux GitHub open-source (Discord-Anti-Scam & nikolaischunk)', () => {
    it('bloque un domaine présent dans le flux confirmé ainsi que ses sous-domaines', () => {
      const exact = checkDomainAgainstFeeds('free-nitro-drop.ru');
      expect(exact.matched).toBe(true);
      if (exact.matched) {
        expect(exact.source).toBe('github_feed');
        expect(exact.matchedEntry).toBe('free-nitro-drop.ru');
      }

      const sub = checkDomainAgainstFeeds('claim.sub.free-nitro-drop.ru');
      expect(sub.matched).toBe(true);
      if (sub.matched) {
        expect(sub.source).toBe('github_feed');
        expect(sub.matchedEntry).toBe('free-nitro-drop.ru');
      }
    });

    it('bloque un domaine présent dans la liste suspecte', () => {
      const res = checkDomainAgainstFeeds('login.suspicious-airdrop.top');
      expect(res.matched).toBe(true);
      if (res.matched) {
        expect(res.source).toBe('suspicious_feed');
      }
    });

    it('immunise toujours les domaines officiels et bénins même injectés par erreur', () => {
      seedPhishingFeedsForTests(['discord.com', 'steamcommunity.com', 'youtube.com']);
      expect(checkDomainAgainstFeeds('discord.com').matched).toBe(false);
      expect(checkDomainAgainstFeeds('cdn.discordapp.com').matched).toBe(false);
      expect(checkDomainAgainstFeeds('steamcommunity.com').matched).toBe(false);
      expect(checkDomainAgainstFeeds('youtube.com').matched).toBe(false);
    });
  });

  describe('Squelette visuel, homoglyphes IDN/punycode et typosquatting', () => {
    it('replie les homoglyphes cyrilliques et les digrammes trompeurs (rn→m, cl→d)', () => {
      // 'dіscord' avec і cyrillique (U+0456)
      expect(visualSkeleton('d\u0456scord')).toBe(visualSkeleton('discord'));
      // 'stearncommunity' avec 'rn' au lieu de 'm'
      expect(visualSkeleton('stearncommunity')).toBe(visualSkeleton('steamcommunity'));
      // 'discorcl' avec 'cl' au lieu de 'd'
      expect(visualSkeleton('discorcl')).toBe(visualSkeleton('discord'));
    });

    it('détecte les domaines IDN cyrilliques / punycode imitant Discord', () => {
      const domains = extractDomains('Récupère ton cadeau sur https://d\u0456scord.com/gifts');
      expect(domains).toEqual(['xn--dscord-pvf.com']);

      const lookalike = detectLookalikeDomain(domains[0]!);
      expect(lookalike).not.toBeNull();
      expect(lookalike?.targetBrand).toBe('discord');
      expect(lookalike?.detail).toBe('idn_homoglyph');
    });

    it('détecte les confusions visuelles (stearncommunity, discorcl) et le typosquatting à distance 1', () => {
      expect(detectLookalikeDomain('stearncommunity.com')?.targetBrand).toBe('steamcommunity');
      expect(detectLookalikeDomain('discorcl.com')?.targetBrand).toBe('discord');
      expect(detectLookalikeDomain('dicsord.com')?.targetBrand).toBe('discord');
      expect(detectLookalikeDomain('steamcomunity.com')?.targetBrand).toBe('steamcommunity');
    });

    it('détecte le combo-squatting (marque déguisée + mot-appât)', () => {
      expect(detectLookalikeDomain('dlscord-gift.org')?.targetBrand).toBe('discord');
      expect(detectLookalikeDomain('stearn-skins.ru')?.targetBrand).toBe('steam');
    });

    it('détecte les sous-domaines usurpateurs (discordapp.com.evil.xyz)', () => {
      const lookalike = detectLookalikeDomain('discordapp.com.evil.xyz');
      expect(lookalike?.targetBrand).toBe('discordapp');
      expect(lookalike?.detail).toBe('subdomain_spoof');
    });

    it('ne signale pas des domaines ordinaires sans rapport', () => {
      expect(detectLookalikeDomain('kotbo.fr')).toBeNull();
      expect(detectLookalikeDomain('developer-blog.org')).toBeNull();
      expect(detectLookalikeDomain('discussion-forum.net')).toBeNull();
    });
  });

  describe('Pipeline detectScam unifié', () => {
    it('bloque un lien issu des flux GitHub même sans mot-clé dans le message', () => {
      const res = detectScam('regarde ça https://free-nitro-drop.ru/welcome', makeConfig());
      expect(res.matched).toBe(true);
      if (res.matched) {
        expect(res.pattern).toBe('github_phishing_feed');
        expect(res.domain).toBe('free-nitro-drop.ru');
      }
    });

    it('bloque un domaine nu ou un homoglyphe cyrillique dans un message ou un texte OCR', () => {
      const bare = detectScam('va sur stearncommunity.com pour échanger', makeConfig());
      expect(bare.matched).toBe(true);
      if (bare.matched) {
        expect(bare.pattern).toContain('lookalike:steamcommunity');
      }

      const idn = detectScam('https://d\u0456scord.com/airdrop', makeConfig());
      expect(idn.matched).toBe(true);
      if (idn.matched) {
        expect(idn.pattern).toBe('lookalike:discord:idn_homoglyph');
      }
    });

    it('respecte toujours la whitelist du serveur sur les flux GitHub et lookalikes', () => {
      const cfg = makeConfig({ scamFilterWhitelist: ['free-nitro-drop.ru', 'stearncommunity.com'] });
      expect(detectScam('https://free-nitro-drop.ru/test', cfg).matched).toBe(false);
      expect(detectScam('https://stearncommunity.com/test', cfg).matched).toBe(false);
    });
  });
});
