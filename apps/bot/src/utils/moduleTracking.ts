import {
  setModuleActivation,
  type KotboModule,
} from '../services/analytics/moduleStatsService.js';
import { markModuleExecutionTracked, recordModuleExecution } from '../services/analytics/moduleUsageBuffer.js';
import { resolveModuleKey } from '../services/core/moduleActivationService.js';

/**
 * Wrapper pour tracker automatiquement les performances et l'utilisation des modules
 * Utilisation: wrapModuleTracking(moduleName, handlerFunction, args, options)
 *
 * Passe par le tampon groupé (moduleUsageBuffer.ts) plutôt que d'écrire en
 * base à chaque exécution, sous la clé du registre des modules. Marque
 * l'interaction (premier argument) pour que le suivi central d'index.ts ne la
 * compte pas une seconde fois.
 */
export async function wrapModuleTracking<T extends unknown[]>(
  moduleName: KotboModule,
  handler: (...args: T) => Promise<unknown>,
  args: T,
  options?: {
    actionType?: 'command' | 'api' | 'event';
    actionName?: string;
    guildId?: string;
    userId?: string;
  }
) {
  const startTime = Date.now();
  let success = true;
  markModuleExecutionTracked(args[0]);

  try {
    const result = await handler(...args);
    return result;
  } catch (error: unknown) {
    success = false;
    throw error;
  } finally {
    if (options?.guildId) {
      void recordModuleExecution({
        guildId: options.guildId,
        moduleName: resolveModuleKey(moduleName) ?? moduleName,
        actionType: options.actionType || 'command',
        userId: options.userId,
        durationMs: Date.now() - startTime,
        success,
      });
    }
  }
}

/**
 * Helper pour extraire guildId et userId d'une interaction Discord
 */
/**
 * Source d'evenement exploitable pour le suivi : une interaction ou un message.
 * Type structurel volontaire - la fonction accepte les deux formes et ne se sert
 * que de l'identite du serveur et de l'auteur.
 */
export type TrackableEvent = {
  guildId?: string | null;
  guild?: { id: string } | null;
  user?: { id: string } | null;
  author?: { id: string } | null;
  member?: { user?: { id: string } | null } | null;
};

export function extractTrackingInfo(interaction: TrackableEvent): { guildId?: string; userId?: string } {
  const guildId = interaction.guildId || interaction.guild?.id;
  const userId = interaction.user?.id || interaction.author?.id || interaction.member?.user?.id;
  return { guildId: guildId ?? undefined, userId: userId ?? undefined };
}

/**
 * Mappe les noms de commandes vers les noms de modules Kotbo
 */
export const COMMAND_TO_MODULE: Record<string, KotboModule> = {
  'sanction': 'sanction',
  'warn': 'sanction',
  'kick': 'sanction',
  'ban': 'sanction',
  'tempban': 'sanction',
  'timeout': 'sanction',
  'to': 'sanction',
  'ticket': 'ticket',
  'tickets': 'ticket',
  'giveaway': 'giveaway',
  'rank': 'leveling',
  'level': 'leveling',
  'xp': 'leveling',
  // Le classement compétitif se greffe sur le leveling : il partage sa
  // ligne de statistiques plutôt que d'ouvrir un module de plus.
  'prestige': 'leveling',
  'prestigeadmin': 'leveling',
  'profil': 'profile',
  'profile': 'profile',
  'casier': 'memberCase',
  'dc': 'dcDetection',
  'alt': 'altAccount',
  'setup': 'dashboard',
  'config': 'dashboard',
  'help': 'dashboard',
  'stats': 'analytics',
  'serverstats': 'analytics',
  'invite': 'invite',
  'invites': 'invite',
  'event': 'event',
  'events': 'event',
  'meeting': 'staffLeadership',
  'absent': 'staffLeadership',
  'absence': 'staffLeadership',
  'note': 'staffLeadership',
  'demission': 'staffLeadership',
  'excuse': 'staffLeadership',
  'suggest': 'suggestion',
  'suggestion': 'suggestion',
  'post': 'news',
  'news': 'news',
  'say': 'autoResponse',
  'autoresponse': 'autoResponse',
  'reactionrole': 'reactionRole',
  'reaction-role': 'reactionRole',
  'welcome': 'welcomeGoodbye',
  'goodbye': 'welcomeGoodbye',
  'nickname': 'nicknameModeration',
  'nick': 'nicknameModeration',
  'codepolice': 'codePolice',
  'code-police': 'codePolice',
  'translate': 'translation',
  'traduction': 'translation',
  'youtube': 'youtube',
  'twitch': 'twitch',
  'github': 'githubRelease',
  'tutoring': 'tutoring',
  'digest': 'digest',
  'tempvoice': 'tempVoice',
  'temp-voice': 'tempVoice',
  'honeypot': 'honeypot',
  'autothread': 'autoThread',
  'auto-thread': 'autoThread',
};

/**
 * Détermine le module Kotbo à partir du nom de commande
 */
export function resolveModuleFromCommand(commandName: string): KotboModule {
  const normalizedName = commandName.toLowerCase().replace(/[^a-z0-9]/g, '');
  return COMMAND_TO_MODULE[normalizedName] || 'dashboard';
}

/**
 * Enregistre l'activation/désactivation d'un module
 */
export async function trackModuleActivation(
  guildId: string,
  moduleName: KotboModule,
  enabled: boolean,
  config?: Record<string, unknown>
): Promise<void> {
  try {
    await setModuleActivation(guildId, moduleName, enabled, config);
  } catch (error) {
    console.error(`[ModuleTracking] Failed to track activation for ${moduleName}:`, error);
  }
}
