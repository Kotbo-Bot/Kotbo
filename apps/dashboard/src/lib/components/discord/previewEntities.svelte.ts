/**
 * Textes d'aperçu (gabarits remplis par un exemple) préparés pour
 * @arcscord/discord-ui.
 *
 * Les aperçus écrivent les mentions en clair (« Bienvenue @Lina ») et les
 * émojis du serveur en `<:nom:id>`. La lib, elle, résout `<@id>` et l'image
 * d'un émoji par les `entities` de son cadre : chaque `@pseudo` devient une
 * mention fictive nommée, chaque émoji personnalisé une entité avec son image.
 */
import type { MessageEntities } from '@arcscord/discord-ui-svelte';
import { customEmojiSegments } from '../../emojiParser';

/** Pseudo en clair, comme les gabarits l'écrivent. `@everyone` et `@here` restent tels quels. */
const PLAIN_MENTION = /@([\w.-]+)/g;
const KEEP = new Set(['everyone', 'here']);

/**
 * Identifiant stable pour un pseudo : la même mention garde son entité d'un
 * rendu à l'autre. 18 chiffres, la forme d'un identifiant Discord : le
 * parseur Markdown n'accepte que des mentions de 17 à 20 chiffres.
 */
function mentionId(name: string): string {
  let hash = 2166136261;
  for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return `9${hash.toString().padStart(17, '0')}`;
}

/**
 * `mentions: false` pour un titre ou un nom de champ d'embed : Discord n'y
 * résout pas les mentions, le `@pseudo` reste du texte.
 */
export function toPreviewMarkdown(text: string, { mentions = true }: { mentions?: boolean } = {}): { markdown: string; entities: MessageEntities } {
  const users: NonNullable<MessageEntities['users']> = {};
  const emojis: NonNullable<MessageEntities['emojis']> = {};

  for (const segment of customEmojiSegments(text)) {
    if (segment.type === 'emoji') {
      const id = segment.url.match(/emojis\/(\d+)/)?.[1];
      if (id) emojis[id] = { name: segment.name, image: segment.url };
    }
  }

  const markdown = !mentions ? text : text.replace(PLAIN_MENTION, (whole, name: string) => {
    if (KEEP.has(name)) return whole;
    const id = mentionId(name);
    users[id] = { name };
    return `<@${id}>`;
  });

  return {
    markdown,
    entities: {
      ...(Object.keys(users).length ? { users } : {}),
      ...(Object.keys(emojis).length ? { emojis } : {}),
    },
  };
}

export function mergeEntities(list: MessageEntities[]): MessageEntities {
  const merged: MessageEntities = {};
  for (const entities of list) {
    if (entities.users) merged.users = { ...merged.users, ...entities.users };
    if (entities.emojis) merged.emojis = { ...merged.emojis, ...entities.emojis };
  }
  return merged;
}

/**
 * Noms déclarés par les éléments d'un aperçu (un embed glissé dans le
 * message, par exemple) pour le cadre qui les affiche.
 */
export class PreviewEntities {
  sources = $state<Record<string, MessageEntities>>({});

  set(key: string, entities: MessageEntities): void {
    this.sources[key] = entities;
  }

  remove(key: string): void {
    delete this.sources[key];
  }
}

export const PREVIEW_ENTITIES = Symbol('preview-entities');
