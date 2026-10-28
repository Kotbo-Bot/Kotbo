import type { Client } from 'discord.js';
import { fetchExternal } from '../../utils/http.js';
import { assertWebhookUrlReachable } from '../integrations/outgoingWebhookSecurity.js';

export interface CustomBotProfile {
  botName?: string | null;
  botAvatarUrl?: string | null;
  botBannerUrl?: string | null;
  botBio?: string | null;
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Télécharge une image que le serveur a saisie. L'URL est contrôlée comme celle
 * d'un webhook sortant (https, pas de réseau interne) et les redirections sont
 * refusées : elles contourneraient ce contrôle.
 * shortcut: le poids n'est vérifié qu'une fois le corps reçu (borné par le délai
 * de 8 s de fetchExternal), à resserrer si des images énormes passent.
 */
async function fetchImage(raw: string): Promise<Buffer> {
  const url = await assertWebhookUrlReachable(raw);
  const response = await fetchExternal(url, { redirect: 'error' });
  if (!response.ok) throw new Error(`Image inaccessible (HTTP ${response.status}).`);
  if (!response.headers.get('content-type')?.startsWith('image/')) throw new Error("Le lien ne pointe pas vers une image.");
  const image = Buffer.from(await response.arrayBuffer());
  if (image.length > MAX_IMAGE_BYTES) throw new Error('Image trop lourde (8 Mo maximum).');
  return image;
}

/**
 * Pousse nom, avatar, bannière et bio vers Discord. Chaque champ échoue seul :
 * Discord limite le changement de pseudo à deux par heure, ce qui ne doit pas
 * empêcher l'avatar de passer. Renvoie les champs refusés, un message chacun.
 */
export async function applyCustomBotProfile(client: Client<true>, profile: CustomBotProfile): Promise<string[]> {
  const errors: string[] = [];
  const attempt = async (label: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (err) {
      errors.push(`${label} : ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const name = profile.botName?.trim();
  if (name && name !== client.user.username) await attempt('Nom', () => client.user.setUsername(name));
  if (profile.botAvatarUrl) {
    const url = profile.botAvatarUrl;
    await attempt('Avatar', async () => client.user.setAvatar(await fetchImage(url)));
  }
  if (profile.botBannerUrl) {
    const url = profile.botBannerUrl;
    await attempt('Bannière', async () => client.user.setBanner(await fetchImage(url)));
  }
  if (profile.botBio != null && client.application) {
    const bio = profile.botBio;
    await attempt('Bio', () => client.application.edit({ description: bio }));
  }
  return errors;
}
