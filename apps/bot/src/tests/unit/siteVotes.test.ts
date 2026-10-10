/**
 * Votes : liens de vote acceptés, lien personnalisé du membre, délais,
 * lecture des réponses des sites de classement.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { memberVoteUrl, normalizeVoteCooldown, normalizeVoteUrl, voteWindow } from '@kotbo/shared';
import { verifyVote, voteKeyFromUrl } from '../../services/site/siteVoteVerifier.js';

describe('liens de vote', () => {
  test('HTTPS et domaine du site de classement uniquement', () => {
    expect(normalizeVoteUrl('topgg', 'https://top.gg/fr/servers/123/vote')).toBe('https://top.gg/fr/servers/123/vote');
    expect(normalizeVoteUrl('topserveurs', 'https://top-serveurs.net/minecraft/vote/mon-serveur')).toContain('top-serveurs.net');
    expect(normalizeVoteUrl('topgg', 'http://top.gg/servers/1/vote')).toBeNull();
    expect(normalizeVoteUrl('topgg', 'https://top.gg.evil.fr/vote')).toBeNull();
    expect(normalizeVoteUrl('topgg', 'javascript:alert(1)')).toBeNull();
  });

  test('identifiant du membre ajouté seulement pour une vérification par membre', () => {
    expect(memberVoteUrl('discordtop', 'https://discordtop.net/vote/abc', '111111111111111111')).toBe('https://discordtop.net/vote/abc?external_id=111111111111111111');
    expect(memberVoteUrl('topgg', 'https://top.gg/servers/1/vote', '111111111111111111')).toBe('https://top.gg/servers/1/vote');
  });

  test('délai borné, fenêtre stable dans un même créneau', () => {
    expect(normalizeVoteCooldown(0, 'topgg')).toBe(1);
    expect(normalizeVoteCooldown(999, 'topgg')).toBe(168);
    expect(normalizeVoteCooldown('abc', 'topgg')).toBe(12);
    const base = Date.UTC(2026, 9, 10, 10, 0, 0);
    expect(voteWindow(new Date(base), 2)).toBe(voteWindow(new Date(base + 30 * 60_000), 2));
    expect(voteWindow(new Date(base), 2)).not.toBe(voteWindow(new Date(base + 2 * 3_600_000), 2));
  });

  test('identifiant du serveur déduit du lien', () => {
    expect(voteKeyFromUrl('serveursminecraft', 'https://www.serveurs-minecraft.org/vote.php?id=4242')).toBe('4242');
    expect(voteKeyFromUrl('listeserveurs', 'https://www.liste-serveurs.fr/mon-serveur.987')).toBe('987');
    expect(voteKeyFromUrl('topgg', 'https://top.gg/servers/1/vote')).toBeNull();
  });
});

describe('vérification auprès des sites de classement', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const answer = (body: unknown, status = 200) => {
    const calls: string[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${String(url)} ${JSON.stringify(init?.headers ?? {})}`);
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return calls;
  };

  test('top-serveurs : code 200 = a voté, adresse IP transmise', async () => {
    const calls = answer({ code: 200 });
    expect(await verifyVote('topserveurs', { key: 'tok', ip: '1.2.3.4', userId: '1' })).toBe(true);
    expect(calls[0]).toContain('server_token=tok&ip=1.2.3.4');
    answer({ code: 404 });
    expect(await verifyVote('topserveurs', { key: 'tok', ip: '1.2.3.4', userId: '1' })).toBe(false);
  });

  test('sans adresse IP, pas de vérification par IP', async () => {
    const calls = answer({ code: 200 });
    expect(await verifyVote('topserveurs', { key: 'tok', ip: null, userId: '1' })).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test('DiscordTop : jeton Bearer et identifiant du membre', async () => {
    const calls = answer({ has_voted: true });
    expect(await verifyVote('discordtop', { key: 'secret', ip: null, userId: '111111111111111111' })).toBe(true);
    expect(calls[0]).toContain('external_id=111111111111111111');
    expect(calls[0]).toContain('Bearer secret');
  });

  test('chemin pointé et inversion « peut voter »', async () => {
    answer({ data: { voted: true } });
    expect(await verifyVote('serveurliste', { key: 'k', ip: '1.1.1.1', userId: '1' })).toBe(true);
    answer({ canVote: false });
    expect(await verifyVote('serveurminecraftvote', { key: '5', ip: '1.1.1.1', userId: '1' })).toBe(true);
    answer({ canVote: true });
    expect(await verifyVote('serveurminecraftvote', { key: '5', ip: '1.1.1.1', userId: '1' })).toBe(false);
  });

  test('erreur du site de classement : vote non reconnu, sans exception', async () => {
    answer('oups', 500);
    expect(await verifyVote('topgames', { key: 'k', ip: '1.1.1.1', userId: '1' })).toBe(false);
    expect(await verifyVote('topgg', { key: 'k', ip: '1.1.1.1', userId: '1' })).toBe(false);
  });
});
