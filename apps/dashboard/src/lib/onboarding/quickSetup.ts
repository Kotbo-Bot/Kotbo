/**
 * Les écritures partagées entre un écran et l'installation express : un seul
 * endroit dit ce que « modération équilibrée » et « accueil » écrivent.
 */
import { fetchWelcomeConfig, updateAutoModConfig, updateRaidProtection, updateWelcomeConfig } from '../api';
import { AUTOMOD_PRESETS, type AutomodPreset } from '@kotbo/shared';
import { saveInBackground } from './backgroundSave';
import { wizard } from '../stores/onboardingWizard.svelte';
import { bot } from '../stores/botLocale.svelte';
import { m } from '../i18n';
import type { ModerationLevel } from './presets';

export async function saveModeration(level: ModerationLevel): Promise<void> {
  const preset = AUTOMOD_PRESETS.find((entry: AutomodPreset) => entry.id === level);
  if (!preset) throw new Error(m.onb_moderation_unknown_level());
  await updateAutoModConfig(preset.filters, undefined, { silent: true });
  await updateRaidProtection(preset.raid, undefined, { silent: true });
}

export async function saveGreeting(message: string): Promise<void> {
  await updateWelcomeConfig({ welcomeEnabled: true, welcomeMessage: message }, undefined, { silent: true });
}

/**
 * Ce que l'installation express règle sans écran : la modération équilibrée, et
 * l'accueil si la structure a bien été posée (sans elle, aucun salon ne
 * recevrait le message). Un message déjà écrit est gardé.
 */
export function applyExpress(): void {
  if (!wizard.isDone('moderation')) {
    void saveInBackground('moderation', () => saveModeration('standard'), m.onb_moderation_save_failed());
  }
  if (wizard.isDone('structure') && !wizard.isDone('greeting')) {
    void saveInBackground('greeting', async () => {
      const config = await fetchWelcomeConfig();
      const vars = { user: '{user}', server: '{server}' };
      await saveGreeting(config?.welcomeMessage || m.bot_greet_default_server(vars, bot()));
    }, m.onb_greeting_save_failed());
  }
}
