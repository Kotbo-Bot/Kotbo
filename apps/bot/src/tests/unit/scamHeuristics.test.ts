import { describe, expect, it } from 'bun:test';
import {
  extractDomains,
  fingerprintText,
  isBenignDomain,
  looksLikeFakeGiveaway,
  looksLikeRecruitmentScam,
  normalizeScamText,
  registrableDomain,
  suspiciousDomainsOf,
} from '../../services/moderation/scamHeuristics.js';

const MRBEAST_FAKE = `I am pleased to announce the launch of my own cryptocurrency casino linked to our recent launch of the Vyro project! To celebrate this big event, I am giving away $3,500 to everyone who registers, and you can withdraw the bonus immediately.

How to claim your reward:
Go to: sedowin.com
Enter the special promo code: TAKE
Receive your $3,500 bonus

This post will be deleted an hour after publication so that only the fastest people will find out about the bonus! The promotion will last for several days, so don't miss your chance!`;

describe('extractDomains', () => {
  it('trouve un domaine sans schéma', () => {
    expect(extractDomains('Go to: sedowin.com puis code TAKE')).toEqual(['sedowin.com']);
  });

  it('trouve un domaine avec schéma et chemin, sans www', () => {
    expect(extractDomains('https://www.sedowin.com/profile/withdraw')).toEqual(['sedowin.com']);
  });

  it('déplie les liens écrits avec [.]', () => {
    expect(extractDomains('sedowin[.]com')).toEqual(['sedowin.com']);
  });

  it('ignore les caractères invisibles glissés dans le domaine', () => {
    expect(extractDomains('sedo​win.com')).toEqual(['sedowin.com']);
  });

  it('ne prend pas un nom de fichier ou une adresse mail pour un domaine', () => {
    expect(extractDomains('voir script.js et contact@exemple.com')).toEqual([]);
  });
});

describe('suspiciousDomainsOf', () => {
  it('écarte les domaines courants et les raccourcisseurs', () => {
    expect(suspiciousDomainsOf('https://youtube.com/watch?v=1 https://bit.ly/abc https://cdn.discordapp.com/x.png')).toEqual([]);
  });

  it('remonte au domaine enregistrable', () => {
    expect(suspiciousDomainsOf('https://go.sedowin.com/x')).toEqual(['sedowin.com']);
  });

  it('garde l’hôte d’un hébergeur mutualisé plutôt que la plateforme', () => {
    expect(suspiciousDomainsOf('https://promo-mrbeast.vercel.app')).toEqual(['promo-mrbeast.vercel.app']);
  });
});

describe('registrableDomain / isBenignDomain', () => {
  it('gère les suffixes à deux niveaux', () => {
    expect(registrableDomain('shop.exemple.co.uk')).toBe('exemple.co.uk');
  });

  it('reconnaît un sous-domaine d’un domaine courant', () => {
    expect(isBenignDomain('media.discordapp.net')).toBe(true);
    expect(isBenignDomain('sedowin.com')).toBe(false);
  });
});

describe('looksLikeFakeGiveaway', () => {
  it('détecte le faux giveaway MrBeast', () => {
    const result = looksLikeFakeGiveaway(MRBEAST_FAKE);
    expect(result.matched).toBe(true);
    expect(result.signals).toEqual(expect.arrayContaining(['giveaway', 'promo_code', 'crypto_casino', 'urgency']));
  });

  it('détecte la version courte typique d’un message de compte piraté', () => {
    const text = 'MrBeast is giving away $5,000 to everyone! Withdraw in USDT, use promo code GIFT on sedowin.com, hurry limited time';
    expect(looksLikeFakeGiveaway(text).matched).toBe(true);
  });

  it('ne signale pas une annonce de giveaway ordinaire', () => {
    const text = 'Giveaway du serveur : un bonus de 500 XP pour tous, tirage vendredi, bonne chance à tous !';
    expect(looksLikeFakeGiveaway(text).matched).toBe(false);
  });

  it('ne signale pas une boutique légitime qui accepte la crypto', () => {
    const text = 'Boutique : paiement en bitcoin accepté, utilise le code promo BIENVENUE pour 10% de réduction';
    expect(looksLikeFakeGiveaway(text).matched).toBe(false);
  });

  it('ne signale pas une discussion sur la crypto', () => {
    expect(looksLikeFakeGiveaway('le bitcoin a pris 5% aujourd’hui, mon wallet est content').matched).toBe(false);
  });
});

describe('looksLikeRecruitmentScam', () => {
  it('détecte le faux recrutement « revenu complémentaire, MP avec ta nationalité »', () => {
    const text = `Bonjour à tous !

J'ai préparé quelques informations à l'intention des personnes actuellement sans emploi ou à la recherche d'un revenu complémentaire.

Il vous suffit d'un ordinateur (fixe ou portable) et d'un peu d'accompagnement pour générer un revenu convenable.

Si cela vous intéresse, merci de m'envoyer un message privé en précisant votre nationalité.`;
    const result = looksLikeRecruitmentScam(text);
    expect(result.matched).toBe(true);
    expect(result.signals).toEqual(
      expect.arrayContaining(['income_promise', 'job_targeting', 'low_barrier', 'dm_lure', 'qualifier'])
    );
  });

  it('détecte la variante anglaise « earn $100k, 10% commission, ask me HOW »', () => {
    const text =
      "I'll help 10 people how to earn $100k in 72 hours from the crypto market. You will pay me 10% commission " +
      'when you receive your profit. If interested send me a direct message via WhatsApp by asking me (HOW)';
    expect(looksLikeRecruitmentScam(text).matched).toBe(true);
  });

  it('ne signale pas une vraie offre de mission', () => {
    const text = 'Je cherche un développeur Svelte pour une mission de 3 mois, payé 450 € par jour, envoie-moi un MP avec ton portfolio';
    expect(looksLikeRecruitmentScam(text).matched).toBe(false);
  });

  it('ne signale pas un recrutement de modérateurs', () => {
    const text = 'On recrute des modérateurs ! Envoyez un message privé en précisant votre âge et vos disponibilités.';
    expect(looksLikeRecruitmentScam(text).matched).toBe(false);
  });

  it('ne signale pas un membre qui parle de sa recherche d’emploi', () => {
    const text = "Je suis sans emploi depuis 3 mois, quelqu'un connaît une boîte qui recrute à Lyon ? Écrivez-moi si vous avez une piste";
    expect(looksLikeRecruitmentScam(text).matched).toBe(false);
  });
});

describe('normalizeScamText / fingerprintText', () => {
  it('donne la même empreinte quand seuls le montant, le lien et la casse changent', () => {
    const a = normalizeScamText('I am giving away $3,500 to everyone who registers. Go to sedowin.com and enter promo code TAKE');
    const b = normalizeScamText('i am giving away $3,700 to EVERYONE who registers. go to https://other-casino.xyz and enter promo code TAKE');
    expect(fingerprintText(a)).toBe(fingerprintText(b));
  });

  it('retire les mentions et les caractères invisibles', () => {
    const normalized = normalizeScamText('@everyone <@123456789> fr​ee gift');
    expect(normalized).toBe('free gift');
  });

  it('borne la taille de l’échantillon', () => {
    expect(normalizeScamText('mot '.repeat(500)).length).toBeLessThanOrEqual(600);
  });
});
