/**
 * Rattachement des outils MCP aux modules du registre.
 *
 * Les routes du dashboard refusent quand leur module est éteint ; les outils
 * MCP, qui appellent les mêmes services, n'avaient aucune garde. Une clé
 * pouvait donc créditer de l'XP ou ouvrir un giveaway sur un serveur qui avait
 * coupé le module.
 *
 * Le rattachement se lit dans le nom de l'outil, première règle gagnante :
 * l'ordre compte (`get_rpg_quests` est de l'économie avant d'être une quête).
 * Un outil qu'aucune règle ne reconnaît reste sans garde - c'est le cas des
 * gestes Discord génériques (salons, rôles, messages) et des outils qui
 * rallument les modules : la garde ne doit pas fermer ce qu'elle ne sait pas
 * décrire.
 */
import { getModuleDefinition } from '@kotbo/contracts';
import { err, type McpToolHandler } from './toolResult.js';

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/marketplace/, 'marketplace'],
  [/rpg|economy|gambling|_coins$|^get_shop|_shop_/, 'economy'],
  [/ticket/, 'tickets'],
  [/giveaway|giveway/, 'giveaways'],
  [/(^|_)site(_|$)/, 'site'],
  [/ban_appeal/, 'ban_appeals'],
  [/sanction/, 'sanctions'],
  [/automod|banned_words/, 'automod'],
  [/code_police/, 'codepolice'],
  [/nickname/, 'nickname_moderation'],
  [/link(ed)?_accounts/, 'double_accounts'],
  [/auto_response/, 'auto_responses'],
  [/workflow/, 'workflows'],
  [/(^|_)quests?(_|$)/, 'quests'],
  [/clan|bettor/, 'clans'],
  [/season/, 'seasons'],
  [/reputation/, 'reputation'],
  [/leveling|level_role|_xp$|^get_member_level$|^get_leaderboard$/, 'leveling'],
  [/suggestion/, 'suggestions'],
  [/custom_form/, 'custom_forms'],
  [/custom_event|^get_events$|^delete_event$|^update_event_status$/, 'events'],
  [/channel_health|overloaded_channel|inactive_channel/, 'channel_health'],
  [/regulation/, 'regulation'],
  [/welcome/, 'welcome_goodbye'],
  [/staff_absence/, 'absences'],
  [/staff_meeting/, 'meetings'],
  [/staff_poll/, 'polls'],
  [/staff_role|hierarch/, 'staff_roles'],
  [/staff_evaluation/, 'evaluations'],
  [/^get_staff_(list|member)$/, 'staff_directory'],
  [/analytics|pulse|hourly_activity|member_daily_stats|prediction/, 'analytics'],
  [/digest/, 'digest'],
];

/** Module dont relève l'outil, ou `undefined` s'il n'en relève d'aucun. */
export function mcpToolModule(toolName: string): string | undefined {
  return RULES.find(([pattern]) => pattern.test(toolName))?.[1];
}

/**
 * Enveloppe le gestionnaire d'un outil : il refuse quand son module est éteint
 * sur le serveur de la clé. L'état est lu à chaque appel, pas à
 * l'enregistrement - une session MCP dure plus longtemps qu'une bascule.
 */
export function withModuleGate(
  toolName: string,
  handler: McpToolHandler,
  isEnabled: (moduleKey: string) => Promise<boolean>,
): McpToolHandler {
  const moduleKey = mcpToolModule(toolName);
  if (!moduleKey) return handler;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (args: any) => {
    if (await isEnabled(moduleKey)) return handler(args);
    const moduleName = getModuleDefinition(moduleKey)?.name ?? moduleKey;
    return err(`Le module « ${moduleName} » est désactivé sur ce serveur.`);
  };
}
