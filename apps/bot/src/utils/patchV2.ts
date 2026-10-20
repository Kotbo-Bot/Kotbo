import * as discord from 'discord.js';
import { E } from './emojis.js';
import { getCurrentInstance } from './instanceContext.js';
import { getClient } from './client.js';
import { getGuildContext } from './guildContext.js';

const COLORS_RAW = {
  primary: 0x5865f2,
  success: 0x57f287,
  danger: 0xed4245,
  warning: 0xfee75c,
  info: 0x5865f2,
  dark: 0x2b2d31,
  pink: 0xeb459e,
};

const EMOJI_PREFIX_REGEX = /^(?:<a?:\w+:\d+>|[\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF])/;

const SAFE_LINK_URL = /^https?:\/\/[^\s<>]+$/i;

/**
 * Lien markdown masqué, sans chevrons intérieurs que Discord n'interprète pas
 * dans les parenthèses de lien [texte](url). Les parenthèses de l'URL sont
 * échappées en pourcentages (%28, %29) pour éviter qu'une parenthèse fermante
 * ne clôture prématurément le lien markdown.
 */
function markdownLink(label: string, url: unknown): string {
  if (typeof url !== 'string') return label;
  const href = url.trim();
  if (!SAFE_LINK_URL.test(href)) return label;
  // Les crochets du libellé et les parenthèses de l'URL casseraient la syntaxe markdown.
  const safeHref = href.replace(/\(/g, '%28').replace(/\)/g, '%29');
  return `[${label.replace(/[[\]]/g, '\\$&')}](${safeHref})`;
}

function getEmojiForTitle(title: string): string | null {
  const t = title.toLowerCase();
  if (t.includes('succès') || t.includes('réussi') || t.includes('validé') || t.includes('confirmé') || t.includes('terminé') || t.includes('success')) {
    return E.success;
  }
  if (t.includes('erreur') || t.includes('échec') || t.includes('impossible') || t.includes('annulé') || t.includes('non trouvé') || t.includes('error')) {
    return E.error;
  }
  if (t.includes('attention') || t.includes('avertissement') || t.includes('warn') || t.includes('warning') || t.includes('expire')) {
    return E.warning;
  }
  if (t.includes('statistique') || t.includes('stats') || t.includes('analytics')) {
    return E.stats;
  }
  if (t.includes('classement') || t.includes('leaderboard') || t.includes('top 10') || t.includes('trophée')) {
    return E.trophy;
  }
  if (t.includes('configuration') || t.includes('config') || t.includes('paramètre') || t.includes('setup')) {
    return E.settings;
  }
  if (t.includes('casier') || t.includes('sanction') || t.includes('infraction') || t.includes('modération') || t.includes('bannissement') || t.includes('exclusion') || t.includes('ban') || t.includes('kick') || t.includes('mute') || t.includes('timeout')) {
    return E.shield;
  }
  if (t.includes('ticket') || t.includes('support')) {
    return E.ticket;
  }
  if (t.includes('daily algo') || t.includes('daily-algo') || t.includes('algorithme') || t.includes('exercice')) {
    return E.fire;
  }
  if (t.includes('rpg') || t.includes('pièce') || t.includes('coins') || t.includes('boutique') || t.includes('shop') || t.includes('argent') || t.includes('banque')) {
    return E.coins;
  }
  if (t.includes('profil') || t.includes('profile')) {
    return E.profile;
  }
  if (t.includes('actualité') || t.includes('news') || t.includes('youtube') || t.includes('twitch') || t.includes('rss')) {
    return E.news;
  }
  if (t.includes('info') || t.includes('aide') || t.includes('help') || t.includes('information') || t.includes('système')) {
    return E.info;
  }
  return null;
}

export function embedToV2(embed: discord.EmbedBuilder | discord.APIEmbed | Record<string, unknown>): discord.ContainerBuilder {
  const isEmbedBuilder = (val: unknown): val is { toJSON: () => discord.APIEmbed } => {
    return val !== null && typeof val === 'object' && 'toJSON' in val && typeof (val as { toJSON: unknown }).toJSON === 'function';
  };

  const data = isEmbedBuilder(embed) ? embed.toJSON() : (embed as discord.APIEmbed);

  const color = data.color ?? COLORS_RAW.primary;
  const c = new discord.ContainerBuilder().setAccentColor(color);

  // Parse title & prefix custom emoji
  let title = data.title ? String(data.title).trim() : '';
  // Un titre cliquable ne peut pas rester dans un heading : Discord n'y rend
  // aucun lien et affiche la syntaxe brute. On repasse alors au gras, qui est
  // aussi le rendu des titres d'embeds classiques.
  let titleIsLinked = false;
  if (title) {
    const emoji = EMOJI_PREFIX_REGEX.test(title) ? null : getEmojiForTitle(title);
    // Le lien enveloppe le titre seul : l'emoji reste hors du libelle cliquable.
    const linked = markdownLink(title, data.url);
    titleIsLinked = linked !== title;
    title = titleIsLinked ? `**${linked}**` : title;
    if (emoji) {
      title = `${emoji} ${title}`;
    }
  }

  // Construct author header
  let authorHeader = '';
  if (data.author?.name) {
    authorHeader = `**${markdownLink(data.author.name.trim(), data.author.url)}**\n`;
  }

  let fullTitle = '';
  if (authorHeader || title) {
    fullTitle = titleIsLinked ? `${authorHeader}${title}` : `${authorHeader}### ${title || 'Info'}`;
  }

  // Text section + thumbnail accessory
  if (fullTitle) {
    if (data.thumbnail?.url) {
      c.addSectionComponents(
        new discord.SectionBuilder()
          .addTextDisplayComponents(new discord.TextDisplayBuilder().setContent(fullTitle))
          .setThumbnailAccessory(new discord.ThumbnailBuilder({ media: { url: data.thumbnail.url } }))
      );
    } else {
      c.addTextDisplayComponents(new discord.TextDisplayBuilder().setContent(fullTitle));
    }
  } else if (data.thumbnail?.url) {
    c.addSectionComponents(
      new discord.SectionBuilder()
        .setThumbnailAccessory(new discord.ThumbnailBuilder({ media: { url: data.thumbnail.url } }))
    );
  }

  // Description
  if (data.description) {
    c.addTextDisplayComponents(new discord.TextDisplayBuilder().setContent(data.description));
  }

  // Fields
  if (data.fields?.length) {
    c.addSeparatorComponents(new discord.SeparatorBuilder().setDivider(true).setSpacing(discord.SeparatorSpacingSize.Small));
    for (const field of data.fields) {
      if (field.name && field.value) {
        c.addTextDisplayComponents(
          new discord.TextDisplayBuilder().setContent(`**${field.name}**\n${field.value}`)
        );
      }
    }
  }

  // Image (media gallery)
  if (data.image?.url) {
    c.addMediaGalleryComponents(
      new discord.MediaGalleryBuilder().addItems(
        new discord.MediaGalleryItemBuilder({ media: { url: data.image.url } })
      )
    );
  }

  // Footer
  if (data.footer?.text) {
    c.addSeparatorComponents(new discord.SeparatorBuilder().setDivider(false).setSpacing(discord.SeparatorSpacingSize.Small));
    c.addTextDisplayComponents(new discord.TextDisplayBuilder().setContent(`-# ${data.footer.text}`));
  }

  return c;
}

function patchFlags(flags: unknown): unknown {
  const IsComponentsV2 = discord.MessageFlags.IsComponentsV2;
  if (!flags) {
    return [IsComponentsV2];
  }
  if (Array.isArray(flags)) {
    if (!flags.includes(IsComponentsV2)) {
      flags.push(IsComponentsV2);
    }
    return flags;
  }
  if (typeof flags === 'number') {
    return flags | IsComponentsV2;
  }
  const flagObj = flags as { has?: (f: number) => boolean; add?: (f: number) => void };
  if (typeof flagObj.has === 'function' && typeof flagObj.add === 'function') {
    flagObj.add(IsComponentsV2);
    return flagObj;
  }
  return [flags, IsComponentsV2];
}

/**
 * Marque (cle Symbol non enumerable) posee sur une charge utile pour que les
 * prototypes patches la laissent EXACTEMENT telle quelle : ni conversion en
 * Components V2, ni drapeau IsComponentsV2 ajoute.
 *
 * Forme retenue : une cle Symbol issue du registre global, plutot qu'un champ
 * texte ou un `Symbol()` local.
 * - une cle Symbol ne peut collisionner avec aucun champ de l'API Discord et
 *   n'apparait ni dans `JSON.stringify`, ni dans `Object.keys` ;
 * - declaree non enumerable, elle ne suit pas non plus un `{ ...payload }` ;
 * - `Symbol.for` survit a deux copies du module chargees dans des registres de
 *   modules separes (bundling, `bun test --isolate`), la ou un `Symbol()` local
 *   donnerait deux marques incompatibles. Meme convention que
 *   `Symbol.for('kotbo.guildContext')` plus bas dans ce fichier.
 * Elle est retiree de la charge avant l'appel d'origine a discord.js, qui
 * rejetterait un champ inconnu.
 */
const SANS_CONVERSION_V2 = Symbol.for('kotbo.sansConversionV2');

/** Marque une charge utile pour que les prototypes patches la laissent EXACTEMENT telle quelle. */
export function sansConversionV2<T extends object>(payload: T): T {
  Object.defineProperty(payload, SANS_CONVERSION_V2, {
    value: true,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return payload;
}

export function estSansConversionV2(options: unknown): boolean {
  return !!options && typeof options === 'object'
    && (options as Record<symbol, unknown>)[SANS_CONVERSION_V2] === true;
}

function transformPayload(options: unknown): unknown {
  if (!options || typeof options !== 'object') {
    return options;
  }

  // Echappatoire explicite de l'appelant : la charge repart telle quelle.
  //
  // La marque N'EST PAS retiree. La supprimer ici la rendait a usage unique :
  // une meme charge construite une fois puis envoyee deux fois — un envoi,
  // puis une edition — repartait en conversion V2 au second passage, et le
  // panneau basculait de V1 a V2 tout seul. La retirer n'avait de toute facon
  // aucune utilite : une cle Symbol non enumerable n'apparait ni dans
  // `JSON.stringify`, ni dans `Object.keys` — discord.js ne la voit jamais.
  if (estSansConversionV2(options)) {
    return options;
  }

  const hasToJSON = 'toJSON' in options && typeof (options as { toJSON: unknown }).toJSON === 'function';
  const hasContent = 'content' in options;
  const hasEmbeds = 'embeds' in options;
  const hasComponents = 'components' in options;

  // If options is a single EmbedBuilder or custom object resembling an embed
  if (options instanceof discord.EmbedBuilder || (hasToJSON && !hasContent && !hasEmbeds && !hasComponents)) {
    return {
      components: [embedToV2(options as discord.EmbedBuilder)],
      flags: [discord.MessageFlags.IsComponentsV2],
      allowedMentions: { parse: [] },
    };
  }

  // If it's a payload containing embeds
  if (hasEmbeds) {
    const payload = options as { content?: string; embeds?: unknown[]; components?: unknown[]; flags?: unknown; allowedMentions?: unknown };
    if (payload.embeds && Array.isArray(payload.embeds) && payload.embeds.length > 0) {
      const containers: discord.ContainerBuilder[] = [];
      for (const embed of payload.embeds) {
        if (embed) {
          containers.push(embedToV2(embed as discord.EmbedBuilder));
        }
      }

      if (containers.length > 0) {
        const originalComponents = payload.components || [];
        const newComponents: unknown[] = [];

        if (payload.content) {
          newComponents.push(
            new discord.TextDisplayBuilder().setContent(payload.content)
          );
          delete payload.content;
        }

        newComponents.push(...containers);
        newComponents.push(...(originalComponents as unknown[]));

        payload.components = newComponents;
        delete payload.embeds;
        payload.flags = patchFlags(payload.flags);

        // Classic embeds never triggered ping notifications for mentions
        // inside them; preserve that silent behavior by default so mentions
        // still render as tags without pinging, unless the caller explicitly
        // set their own allowedMentions.
        if (payload.allowedMentions === undefined) {
          payload.allowedMentions = { parse: [] };
        }
      }
    }
  }

  return options;
}

function isV2Message(message: unknown): boolean {
  const flags = (message as { flags?: { has?: (f: number) => boolean } } | null | undefined)?.flags;
  return typeof flags?.has === 'function' && flags.has(discord.MessageFlags.IsComponentsV2);
}

/**
 * Vrai si ce message porte deja le drapeau IsComponentsV2.
 *
 * CONTRAINTE DURE (API Discord) : le drapeau IsComponentsV2 ne peut pas etre
 * RETIRE d'un message existant. Une edition qui l'omet ne fait pas repasser le
 * message en embeds classiques : elle est refusee. Un panneau deja poste en V2
 * est donc definitivement en V2.
 *
 * CE QUE L'APPELANT DOIT FAIRE quand cette fonction renvoie vrai : garder le
 * rendu V2 pour CE message-la (donc ne PAS marquer la charge avec
 * `sansConversionV2`, l'edition echouerait), et ne faire prendre effet au
 * reglage V1 qu'au prochain panneau cree - en repostant un message neuf si le
 * rendu V1 est exige tout de suite. Ne jamais tenter l'edition « pour voir ».
 */
export function messageEstV2(message: unknown): boolean {
  return isV2Message(message);
}

// update()/edit() target an existing message: if that message is already
// Components V2, Discord rejects legacy fields (content/embeds) even when
// transformPayload left them alone (e.g. content-only payloads with no
// embeds). Convert content into a TextDisplay so the update stays valid.
export function transformUpdatePayload(options: unknown, targetMessage: unknown): unknown {
  // Lu AVANT transformPayload, qui consomme la marque au passage.
  const sansConversion = estSansConversionV2(options);
  const transformed = transformPayload(options);
  if (sansConversion || !isV2Message(targetMessage)) {
    return transformed;
  }

  if (typeof transformed === 'string') {
    return {
      components: [new discord.TextDisplayBuilder().setContent(transformed)],
      flags: [discord.MessageFlags.IsComponentsV2],
      allowedMentions: { parse: [] },
    };
  }

  if (!transformed || typeof transformed !== 'object') {
    return transformed;
  }

  const payload = transformed as { content?: unknown; embeds?: unknown[]; components?: unknown[]; flags?: unknown; allowedMentions?: unknown };
  if (typeof payload.content === 'string') {
    if (payload.content.length > 0) {
      const components = Array.isArray(payload.components) ? payload.components : [];
      payload.components = [new discord.TextDisplayBuilder().setContent(payload.content), ...components];
      if (payload.allowedMentions === undefined) {
        payload.allowedMentions = { parse: [] };
      }
    }
    delete payload.content;
    if (Array.isArray(payload.embeds) && payload.embeds.length === 0) {
      delete payload.embeds;
    }
    payload.flags = patchFlags(payload.flags);
  }

  return transformed;
}

function appendSendFromButton(transformed: unknown): unknown {
  if (typeof transformed === 'string') {
    transformed = { content: transformed };
  } else if (!transformed || typeof transformed !== 'object') {
    transformed = {};
  }

  const payload = transformed as { components?: unknown[] };

  // Check if a server origin button already exists to prevent duplicate buttons
  const hasOriginButton = Array.isArray(payload.components) && payload.components.some((row: any) => {
    if (!row) return false;
    const components = Array.isArray(row.components)
      ? row.components
      : (typeof row.toJSON === 'function' ? row.toJSON().components : []);
    return Array.isArray(components) && components.some((comp: any) => {
      if (!comp) return false;
      const customId = comp.customId ||
        (typeof comp.toJSON === 'function' ? comp.toJSON().customId : null) ||
        comp.data?.custom_id ||
        comp.custom_id;
      return customId === 'mpsay_server_origin' || customId === 'mpsay_server_origin_auto';
    });
  });

  if (hasOriginButton) {
    return transformed;
  }

  let serverName = 'serveur';
  try {
    const context = getGuildContext();
    if (context?.guildName) {
      serverName = context.guildName;
    } else if (context?.guildId) {
      const client = getClient();
      const guild = client.guilds.cache.get(context.guildId);
      if (guild?.name) {
        serverName = guild.name;
      }
    } else {
      const instance = getCurrentInstance();
      if (instance) {
        serverName = instance.brandName || instance.name || 'serveur';
      }
    }
  } catch {
    // Context or client not initialized yet, fallback to instance if possible
    try {
      const instance = getCurrentInstance();
      if (instance) {
        serverName = instance.brandName || instance.name || 'serveur';
      }
    } catch {
      // ignore
    }
  }

  const button = new discord.ButtonBuilder()
    .setCustomId('mpsay_server_origin_auto')
    .setLabel(`Envoyé depuis : ${serverName}`)
    .setStyle(discord.ButtonStyle.Secondary)
    .setDisabled(true);

  const row = new discord.ActionRowBuilder<discord.ButtonBuilder>().addComponents(button);

  if (!payload.components) {
    payload.components = [];
  } else if (!Array.isArray(payload.components)) {
    payload.components = [payload.components];
  }

  payload.components.push(row);

  return payload;
}

interface PatchItem {
  target: { prototype: Record<string, unknown> };
  methods: string[];
}

// Apply prototype patching to concrete interaction subclasses
const patches: PatchItem[] = [
  { target: discord.CommandInteraction as unknown as { prototype: Record<string, unknown> }, methods: ['reply', 'editReply', 'followUp'] },
  { target: discord.MessageComponentInteraction as unknown as { prototype: Record<string, unknown> }, methods: ['reply', 'editReply', 'followUp', 'update'] },
  // `update` compris : un modal ouvert depuis un composant met a jour le message
  // d'origine, qui est deja en Components V2 des qu'il portait un embed.
  { target: discord.ModalSubmitInteraction as unknown as { prototype: Record<string, unknown> }, methods: ['reply', 'editReply', 'followUp', 'update'] },
  { target: discord.TextChannel as unknown as { prototype: Record<string, unknown> }, methods: ['send'] },
  { target: discord.DMChannel as unknown as { prototype: Record<string, unknown> }, methods: ['send'] },
  { target: discord.ThreadChannel as unknown as { prototype: Record<string, unknown> }, methods: ['send'] },
  { target: discord.NewsChannel as unknown as { prototype: Record<string, unknown> }, methods: ['send'] },
  // Le chat des salons vocaux aussi : un message envoye en legacy puis edite
  // passerait en V2 a l'edition, et Discord refuse alors son `content` d'origine.
  { target: discord.VoiceChannel as unknown as { prototype: Record<string, unknown> }, methods: ['send'] },
  { target: discord.StageChannel as unknown as { prototype: Record<string, unknown> }, methods: ['send'] },
  { target: discord.User as unknown as { prototype: Record<string, unknown> }, methods: ['send'] },
  { target: discord.WebhookClient as unknown as { prototype: Record<string, unknown> }, methods: ['send'] },
  { target: discord.Message as unknown as { prototype: Record<string, unknown> }, methods: ['reply', 'edit'] },
];

for (const patch of patches) {
  const proto = patch.target?.prototype;
  if (!proto) continue;

  for (const method of patch.methods) {
    const original = proto[method];
    if (typeof original !== 'function') continue;

    proto[method] = function (this: unknown, options: unknown, ...args: unknown[]) {
      let transformed: unknown;
      if (method === 'update') {
        transformed = transformUpdatePayload(options, (this as { message?: unknown }).message);
      } else if (method === 'edit') {
        transformed = transformUpdatePayload(options, this);
      } else {
        transformed = transformPayload(options);
      }

      if (patch.target === (discord.User as any) || patch.target === (discord.DMChannel as any)) {
        transformed = appendSendFromButton(transformed);
      }

      return (original as (...args: unknown[]) => unknown).call(this, transformed, ...args);
    };
  }
}

// ── Client Event Listener Context Wrapping ──────────────────
function wrapListener(listener: (...args: any[]) => void) {
  return function (this: any, ...args: any[]) {
    let guildId: string | undefined;
    let guildName: string | undefined;

    for (const arg of args) {
      if (arg && typeof arg === 'object') {
        if ('guild' in arg && arg.guild && typeof arg.guild === 'object') {
          guildId = arg.guild.id;
          guildName = arg.guild.name;
          break;
        } else if ('guildId' in arg && typeof arg.guildId === 'string' && arg.guildId) {
          guildId = arg.guildId;
          try {
            const client = getClient();
            guildName = client.guilds.cache.get(arg.guildId)?.name ?? undefined;
          } catch {
            // Client not ready yet
          }
          break;
        }
      }
    }

    if (guildId) {
      const storage = (globalThis as any)[Symbol.for('kotbo.guildContext')];
      if (storage) {
        return storage.run({ guildId, guildName }, () => {
          return listener.apply(this, args);
        });
      }
    }

    return listener.apply(this, args);
  };
}

const originalOn = discord.Client.prototype.on;
discord.Client.prototype.on = function (this: any, event: string, listener: (...args: any[]) => void) {
  const wrapped = wrapListener(listener);
  (wrapped as any).originalListener = listener;
  return originalOn.call(this, event, wrapped);
};

const originalOnce = discord.Client.prototype.once;
discord.Client.prototype.once = function (this: any, event: string, listener: (...args: any[]) => void) {
  const wrapped = wrapListener(listener);
  (wrapped as any).originalListener = listener;
  return originalOnce.call(this, event, wrapped);
};

const originalOff = discord.Client.prototype.off;
discord.Client.prototype.off = function (this: any, event: string, listener: (...args: any[]) => void) {
  const listeners = this.listeners(event);
  const wrapped = listeners.find((l: any) => l.originalListener === listener || l === listener);
  if (wrapped) {
    return originalOff.call(this, event, wrapped);
  }
  return originalOff.call(this, event, listener);
};

const originalRemoveListener = discord.Client.prototype.removeListener;
discord.Client.prototype.removeListener = function (this: any, event: string, listener: (...args: any[]) => void) {
  const listeners = this.listeners(event);
  const wrapped = listeners.find((l: any) => l.originalListener === listener || l === listener);
  if (wrapped) {
    return originalRemoveListener.call(this, event, wrapped);
  }
  return originalRemoveListener.call(this, event, listener);
};

