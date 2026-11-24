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
import { getModuleDefinition, isRestrictedModule } from '@kotbo/contracts';
import { err, type McpToolHandler } from './toolResult.js';

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // En tête : un outil qui toucherait la cellule ne doit relever d'aucun autre module.
  [/wellbeing/, 'wellbeing'],
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
  [/starboard/, 'starboard'],
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
  [/recruitment/, 'recruitment'],
  [/^get_staff_(list|member)$/, 'staff_directory'],
  [/analytics|pulse|hourly_activity|member_daily_stats|prediction/, 'analytics'],
  [/digest/, 'digest'],
];

/** Refus d'un module confidentiel (voir `ModuleDefinition.restricted`). */
export function closedModuleMessage(moduleKey: string): string {
  return `Le module « ${getModuleDefinition(moduleKey)?.name ?? moduleKey} » n'est pas accessible par le MCP ni par l'API.`;
}

/** Ni l'état du module ni les règles de la clé n'ouvrent un module confidentiel. */
function closedModuleHandler(moduleKey: string): McpToolHandler {
  return async () => err(closedModuleMessage(moduleKey));
}

/** Module dont relève l'outil, ou `undefined` s'il n'en relève d'aucun. */
export function mcpToolModule(toolName: string): string | undefined {
  return RULES.find(([pattern]) => pattern.test(toolName))?.[1];
}

export type McpKeyRight = 'canView' | 'canModerate' | 'canConfigure' | 'canDelete';
export type McpKeyRule = { featureKey: string } & Record<McpKeyRight, boolean>;

/**
 * Droit qu'un outil demande sur son module, lu dans son nom comme la lecture
 * seule de `restApi.ts`. shortcut: heuristique sur le verbe, sans annotation par
 * outil ; à remplacer si un outil est mal rangé.
 */
export function mcpToolRight(toolName: string): McpKeyRight {
  if (/^(get|list|search|read)_/.test(toolName)) return 'canView';
  if (/^(delete|remove|dissolve|void|revoke|cancel)_/.test(toolName)) return 'canDelete';
  if (/^(update|set|save|reorder)_/.test(toolName)) return 'canConfigure';
  return 'canModerate';
}

/**
 * Droits par module d'une clé : une clé sans règle garde ses permissions
 * globales (comportement d'avant) ; dès une règle, tout module sans règle lui
 * est fermé. Un outil sans module reste hors de cette garde.
 */
export function withKeyAccessGate(
  toolName: string,
  handler: McpToolHandler,
  loadRules: () => Promise<McpKeyRule[]>,
): McpToolHandler {
  const moduleKey = mcpToolModule(toolName);
  if (!moduleKey) return handler;
  if (isRestrictedModule(moduleKey)) return closedModuleHandler(moduleKey);
  const right = mcpToolRight(toolName);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (args: any) => {
    const rules = await loadRules();
    if (rules.length === 0 || rules.find((r) => r.featureKey === moduleKey)?.[right]) return handler(args);
    const moduleName = getModuleDefinition(moduleKey)?.name ?? moduleKey;
    return err(`Cette clé n'a pas le droit « ${right} » sur le module « ${moduleName} » (Centre de gestion).`);
  };
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
  if (isRestrictedModule(moduleKey)) return closedModuleHandler(moduleKey);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (args: any) => {
    if (await isEnabled(moduleKey)) return handler(args);
    const moduleName = getModuleDefinition(moduleKey)?.name ?? moduleKey;
    return err(`Le module « ${moduleName} » est désactivé sur ce serveur.`);
  };
}
