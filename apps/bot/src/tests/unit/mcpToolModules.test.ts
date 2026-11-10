/**
 * Rattachement des outils MCP à leur module.
 *
 * Les outils MCP ne passaient par aucune garde de module : une clé pouvait
 * créditer de l'XP ou créer un giveaway sur un serveur qui avait coupé le
 * module correspondant.
 */
import { describe, expect, mock, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { getModuleDefinition } from '@kotbo/contracts';
import { mcpToolModule, withModuleGate } from '../../api/mcp/toolModules.js';

/** Noms réellement enregistrés, lus dans les sources des outils. */
function registeredToolNames(): string[] {
  const dir = path.resolve(import.meta.dir, '../../api/mcp/tools');
  const names = new Set<string>();
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
    const source = readFileSync(path.join(dir, file), 'utf8');
    for (const match of source.matchAll(/registerTool\(\s*['"]([a-z0-9_]+)['"]/g)) names.add(match[1]);
  }
  return [...names];
}

describe('module d\'un outil MCP', () => {
  test('les outils lus dans les sources sont bien trouvés', () => {
    expect(registeredToolNames().length).toBeGreaterThan(300);
  });

  test('tout outil rattaché l\'est à un module du registre', () => {
    for (const name of registeredToolNames()) {
      const moduleKey = mcpToolModule(name);
      if (moduleKey) expect(getModuleDefinition(moduleKey)?.key).toBe(moduleKey);
    }
  });

  test.each([
    ['admin_adjust_xp', 'leveling'],
    ['get_member_level', 'leveling'],
    ['create_level_role_reward', 'leveling'],
    ['admin_adjust_coins', 'economy'],
    ['get_rpg_quests', 'economy'],
    ['start_rpg_tower_season', 'economy'],
    ['get_rpg_leaderboard', 'economy'],
    ['decide_shop_order', 'economy'],
    ['get_marketplace_listings', 'marketplace'],
    ['get_member_quests', 'quests'],
    ['get_season_leaderboard', 'seasons'],
    ['get_reputation_leaderboard', 'reputation'],
    ['create_giveway', 'giveaways'],
    ['send_ticket_macro', 'tickets'],
    ['request_ban_appeal_info', 'ban_appeals'],
    ['import_sanction_discord_transcripts', 'sanctions'],
    ['analyze_channel_health', 'channel_health'],
    ['get_channel_analytics', 'analytics'],
    ['save_site_vote_site', 'site'],
    ['reorder_welcome_menu_pages', 'welcome_goodbye'],
    ['vote_staff_poll', 'polls'],
    ['sync_staff_hierarchies', 'staff_roles'],
    ['add_staff_member_to_hierarchy', 'staff_roles'],
    ['get_staff_member', 'staff_directory'],
    ['get_bettor_standings', 'clans'],
    ['get_site_analytics', 'site'],
  ])('%s relève de %s', (name, moduleKey) => {
    expect(mcpToolModule(name)).toBe(moduleKey);
  });

  test.each([
    'set_module_activation',
    'set_feature_configuration',
    'request_staff_approval',
    'get_widget_subscriptions',
    'update_guild_settings',
    'send_message',
    'create_channel',
  ])('%s ne relève d\'aucun module', (name) => {
    expect(mcpToolModule(name)).toBeUndefined();
  });
});

describe('garde d\'un outil MCP', () => {
  const handler = mock(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));

  test('module éteint : l\'outil refuse sans appeler son gestionnaire', async () => {
    handler.mockClear();
    const gated = withModuleGate('admin_adjust_xp', handler, async () => false);
    const result = await gated({});
    expect(handler).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Leveling');
  });

  test('module allumé : le gestionnaire répond', async () => {
    handler.mockClear();
    const gated = withModuleGate('admin_adjust_xp', handler, async () => true);
    await gated({});
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('outil sans module : le gestionnaire est rendu tel quel', () => {
    expect(withModuleGate('send_message', handler, async () => false)).toBe(handler);
  });
});
