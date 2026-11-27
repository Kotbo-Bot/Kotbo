import { describe, expect, test } from 'bun:test';
import { createPublicInviteRouter } from '../../api/hono/routes/public/invite';

process.env.DISCORD_CLIENT_ID ??= '123456789012345678';

const discordUrl = async (query: string) => {
  const res = await createPublicInviteRouter().request(`/api/public/invite?${query}`);
  return new URL(res.headers.get('location') ?? '');
};

describe('invitation depuis le dashboard (?return=1)', () => {
  test('mène à Discord sur le bon serveur, avec retour et sans cookie', async () => {
    const res = await createPublicInviteRouter().request('/api/public/invite?return=1&perms=admin&guild_id=223456789012345678');
    const url = new URL(res.headers.get('location') ?? '');
    expect(url.host).toBe('discord.com');
    expect(url.searchParams.get('permissions')).toBe('8');
    expect(url.searchParams.get('guild_id')).toBe('223456789012345678');
    expect(url.searchParams.get('disable_guild_select')).toBe('true');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('permissions au détail et identifiant invalide ignoré', async () => {
    const url = await discordUrl('return=1&perms=detailed&guild_id=abc');
    expect(url.searchParams.get('permissions')).not.toBe('8');
    expect(url.searchParams.get('guild_id')).toBeNull();
  });
});
