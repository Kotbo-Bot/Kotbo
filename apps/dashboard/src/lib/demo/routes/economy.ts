/**
 * Routes de démo pour le module Économie & RPG.
 */
import { route } from '../backend';
import { demoDb } from '../db';
import { row, merge } from '../model';

function economyConfigSeed() {
  return row('EconomyConfig', {
    currencyName: 'Pièces',
    currencySymbol: '🪙',
    dailyMin: 100,
    dailyMax: 200,
    dailyStreakBonus: 10,
    dailyStreakMaxDays: 7,
    workMin: 50,
    workMax: 120,
    workCooldownMinutes: 30,
    robSuccessRate: 40,
    robCooldownMinutes: 60,
    clansEnabled: false,
    clanPointsFromRpg: false,
  });
}

export function registerEconomyRoutes(): void {
  // GET /api/dashboard/guilds/:id/economy/config
  route('GET', '/api/dashboard/guilds/:id/economy/config', () => {
    const config = demoDb.get('economy-config', economyConfigSeed);
    return { config: { ...config, clansEnabled: false, clanPointsFromRpg: false } };
  });

  // PATCH /api/dashboard/guilds/:id/economy/config
  route('PATCH', '/api/dashboard/guilds/:id/economy/config', ({ body }) => {
    const config = demoDb.update('economy-config', economyConfigSeed, (current) => merge(current, body));
    return { success: true, config };
  });

  // GET /api/dashboard/guilds/:id/economy/rpg-channels
  route('GET', '/api/dashboard/guilds/:id/economy/rpg-channels', () => {
    const channelIds = demoDb.get('economy-rpg-channels', () => ['900000000000000316']);
    return { channelIds, diverged: false };
  });

  // PUT /api/dashboard/guilds/:id/economy/rpg-channels
  route('PUT', '/api/dashboard/guilds/:id/economy/rpg-channels', ({ body }) => {
    const channelIds = demoDb.set('economy-rpg-channels', body?.channelIds ?? []);
    return { channelIds, diverged: false };
  });

  // GET /api/dashboard/guilds/:id/economy/gambling
  route('GET', '/api/dashboard/guilds/:id/economy/gambling', () => {
    const games = demoDb.get('economy-gambling', () => ({
      dice: true,
      roulette: true,
      rps: true,
      guess: true,
    }));
    return { games };
  });

  // PUT /api/dashboard/guilds/:id/economy/gambling
  route('PUT', '/api/dashboard/guilds/:id/economy/gambling', ({ body }) => {
    const games = demoDb.update('economy-gambling', () => ({}), (current) => ({
      ...current,
      ...(body?.games || {}),
    }));
    return { games };
  });
}
