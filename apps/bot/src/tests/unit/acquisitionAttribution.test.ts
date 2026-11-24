import { describe, expect, test } from 'bun:test';
import { normalizeInviteContent } from '@kotbo/contracts';
import { isBotRequest } from '../../api/shared/botFilter.js';
import {
  makeAttributionCookie,
  readAttributionCookie,
  signInviteState,
  verifyInviteState,
} from '../../api/shared/inviteAttribution.js';

describe('filtrage des bots sur les routes publiques', () => {
  test('bloque les bots connus, requetes HEAD et prefetch', () => {
    expect(isBotRequest({ method: 'HEAD', headers: { 'user-agent': 'Mozilla/5.0' } })).toBe(true);
    expect(isBotRequest({ method: 'GET', headers: { 'user-agent': 'Discordbot/2.0' } })).toBe(true);
    expect(isBotRequest({ method: 'GET', headers: { 'user-agent': 'Googlebot/2.1' } })).toBe(true);
    expect(isBotRequest({ method: 'GET', headers: { 'user-agent': 'curl/8.4.0' } })).toBe(true);
    expect(isBotRequest({ method: 'GET', headers: { 'user-agent': 'Mozilla/5.0', 'sec-purpose': 'prefetch' } })).toBe(true);
    expect(isBotRequest({ method: 'GET', headers: {} })).toBe(true);
  });

  test('laisse passer les navigateurs standards', () => {
    expect(
      isBotRequest({
        method: 'GET',
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
        },
      }),
    ).toBe(false);
  });
});

describe('normalisation des boutons invitation', () => {
  test('supprime le suffixe -final sauf pour le bouton final lui-meme', () => {
    expect(normalizeInviteContent('feature-double_accounts-final')).toBe('feature-double_accounts');
    expect(normalizeInviteContent('blog-automod-final')).toBe('blog-automod');
    expect(normalizeInviteContent('final')).toBe('final');
    expect(normalizeInviteContent('  Hero  ')).toBe('hero');
    expect(normalizeInviteContent('')).toBeNull();
  });
});

describe('attribution signee et cookie OAuth2', () => {
  test('signe et verifie le parametre state', () => {
    const state = signInviteState({
      source: 'landing',
      content: 'hero',
      campaign: 'spring',
      referrer: 'google',
      landingPath: '/features/double-accounts',
      popup: true,
    });

    const parsed = verifyInviteState(state);
    expect(parsed).toEqual({
      source: 'landing',
      content: 'hero',
      campaign: 'spring',
      referrer: 'google',
      landingPath: '/features/double-accounts',
      popup: true,
    });

    // Altération du payload rejetée
    const tampered = `X${state.slice(1)}`;
    expect(verifyInviteState(tampered)).toBeNull();
  });

  test('lit le cookie kotbo_attr', () => {
    const setCookie = makeAttributionCookie({
      source: 'landing',
      content: 'pricing',
      campaign: null,
      referrer: 'discord',
      landingPath: '/',
    });
    const cookiePair = setCookie.split(';')[0]!;
    expect(readAttributionCookie(cookiePair)).toEqual({
      source: 'landing',
      content: 'pricing',
      campaign: null,
      referrer: 'discord',
      landingPath: '/',
    });
  });
});
