import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPublicInviteRouter } from '../../api/hono/routes/public/invite';

const REDIRECT = 'https://api.example.test/api/auth/discord/callback';
const saved = { id: process.env.DISCORD_CLIENT_ID, uri: process.env.DISCORD_REDIRECT_URI };

beforeAll(() => {
  process.env.DISCORD_CLIENT_ID ??= '123456789012345678';
  process.env.DISCORD_REDIRECT_URI = REDIRECT;
});
afterAll(() => {
  if (saved.id === undefined) delete process.env.DISCORD_CLIENT_ID;
  if (saved.uri === undefined) delete process.env.DISCORD_REDIRECT_URI;
  else process.env.DISCORD_REDIRECT_URI = saved.uri;
});

const invite = async (query: string) => {
  const res = await createPublicInviteRouter().request(`/api/public/invite?${query}`);
  return { res, url: new URL(res.headers.get('location') ?? '') };
};

describe('invitation depuis le dashboard (?return=1)', () => {
  test('mène à Discord sur le bon serveur, avec retour et sans cookie', async () => {
    const { res, url } = await invite('return=1&perms=admin&guild_id=223456789012345678');
    expect(res.status).toBe(302);
    expect(url.host).toBe('discord.com');
    expect(url.searchParams.get('permissions')).toBe('8');
    expect(url.searchParams.get('scope')).toBe('bot applications.commands');
    expect(url.searchParams.get('guild_id')).toBe('223456789012345678');
    expect(url.searchParams.get('disable_guild_select')).toBe('true');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('response_type')).toBe('code');
    // La provenance posée à l'arrivée du visiteur ne doit pas être écrasée.
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(url.searchParams.get('state')).toBeNull();
  });

  test('permissions au détail et identifiant invalide ignoré', async () => {
    const { url } = await invite('return=1&perms=detailed&guild_id=abc');
    expect(url.searchParams.get('permissions')).not.toBe('8');
    expect(url.searchParams.get('guild_id')).toBeNull();
    expect(url.searchParams.get('disable_guild_select')).toBeNull();
  });

  test('sans `perms`, jamais Administrateur par défaut', async () => {
    const { url } = await invite('return=1');
    expect(url.searchParams.get('permissions')).not.toBe('8');
  });
});

describe('les trajets existants ne bougent pas', () => {
  test('sans paramètre : « Mes serveurs » du dashboard', async () => {
    const { url } = await invite('');
    expect(url.pathname).toBe('/servers');
  });

  test('?direct=1 : écran Discord, sans retour', async () => {
    const { url } = await invite('direct=1');
    expect(url.host).toBe('discord.com');
    expect(url.searchParams.get('redirect_uri')).toBeNull();
  });
});
