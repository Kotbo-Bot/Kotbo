/** Rendu du markdown Discord en HTML. */
import { Guild } from 'discord.js';

export function formatChannelName(guild: { channels: { cache: Map<string, { id: string; name?: string }> } } | null, channelId: string | null): string {
  if (!channelId) return 'Aucun';
  const channel = guild?.channels.cache.get(channelId);
  return channel?.name ? `#${channel.name}` : `Salon ${channelId}`;
}

/**
 * Mentions Discord resolues en texte lisible, sans balise ni entite HTML.
 *
 * Les journaux et les messages archives repartent vers le dashboard tels
 * quels : c'est lui qui echappe et qui pose les liens. Toute mise en forme
 * appliquee ici ressortirait telle quelle a l'ecran, echappee une seconde
 * fois par le rendu.
 */
export function renderMentionsAsText(guild: Guild | null, content: string): string {
  if (!content) return content;

  return content
    .replace(/<@!?(\d+)>/g, (_match, id: string) => {
      const member = guild?.members.cache.get(id);
      return `@${member ? member.displayName || member.user.username : id}`;
    })
    .replace(/<#(\d+)>/g, (_match, id: string) => {
      const channel = guild?.channels.cache.get(id);
      return `#${channel?.name || id}`;
    })
    .replace(/<@&(\d+)>/g, (_match, id: string) => {
      const role = guild?.roles.cache.get(id);
      return `@${role?.name || id}`;
    });
}


export function escapeHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Classes `dc-*` : le dashboard les met en forme dans son CSS global. Les
 * classes Tailwind posées ici ne sont jamais générées par le dashboard (son
 * Tailwind ne lit pas le code du bot) : sans `dc-*`, un émoji personnalisé
 * s'affichait à sa taille d'origine, 48 px.
 */
export function parseDiscordMarkdown(text: string, guild?: Guild | null): string {
  if (!text) return '';
  let escaped = escapeHtml(text);

  escaped = escaped.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  escaped = escaped.replace(/\*(.*?)\*/g, '<em>$1</em>');
  escaped = escaped.replace(/__(.*?)__/g, '<u>$1</u>');
  escaped = escaped.replace(/~~(.*?)~~/g, '<del>$1</del>');
  escaped = escaped.replace(/`(.*?)`/g, '<code class="dc-code px-1.5 py-0.5 rounded bg-zinc-800 font-mono text-sm">$1</code>');

  escaped = escaped.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const safeLang = escapeHtml(lang || 'plaintext');
    const safeCode = escapeHtml(code);
    return `<pre class="dc-pre p-3 my-2 rounded bg-zinc-800 font-mono text-sm overflow-x-auto"><code class="language-${safeLang}">${safeCode}</code></pre>`;
  });

  // Titres et sous-texte, très employés par les messages en Components V2 du
  // bot (`### Titre`, `-# pied de page`). Une ligne entière à la fois.
  escaped = escaped.replace(/^(#{1,3}) (.+)$/gm, (_, hashes: string, title: string) => {
    const size = hashes.length === 1 ? 'text-lg' : hashes.length === 2 ? 'text-base' : 'text-sm';
    return `<span class="dc-heading dc-h${hashes.length} block font-bold ${size} text-white">${title}</span>`;
  });
  escaped = escaped.replace(/^-# (.+)$/gm, '<span class="dc-subtext block text-xs text-white/50">$1</span>');
  escaped = escaped.replace(/^&gt; (.+)$/gm, '<span class="dc-quote block border-l-4 border-white/20 pl-2">$1</span>');

  // Liens masqués [texte](https://…) : seuls http(s) sont acceptés, et le texte
  // est déjà échappé, l'URL aussi (ni guillemet ni chevron ne peuvent sortir).
  escaped = escaped.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer" class="dc-link text-sky-400 hover:underline">$1</a>');

  escaped = escaped.replace(/&lt;:([a-zA-Z0-9_]+):(\d+)&gt;/g, (_, name, id) => {
    const safeName = escapeHtml(name);
    const safeId = escapeHtml(id);
    return `<img class="dc-emoji inline-block h-[1.375em] w-auto align-middle mx-[0.15em]" src="https://cdn.discordapp.com/emojis/${safeId}.png?size=48&quality=lossless" alt=":${safeName}:" title=":${safeName}:" />`;
  });
  escaped = escaped.replace(/&lt;a:([a-zA-Z0-9_]+):(\d+)&gt;/g, (_, name, id) => {
    const safeName = escapeHtml(name);
    const safeId = escapeHtml(id);
    return `<img class="dc-emoji inline-block h-[1.375em] w-auto align-middle mx-[0.15em]" src="https://cdn.discordapp.com/emojis/${safeId}.gif?size=48&quality=lossless" alt=":${safeName}:" title=":${safeName}:" />`;
  });

  if (guild) {
    escaped = escaped.replace(/&lt;@!?(\d+)&gt;/g, (_, id) => {
      const member = guild.members.cache.get(id);
      const user = guild.client.users.cache.get(id);
      const name = member?.displayName || user?.username || 'Utilisateur';
      const safeName = escapeHtml(name);
      return `<span class="dc-mention font-semibold text-sky-400 px-1.5 py-0.5 bg-sky-500/10 rounded hover:bg-sky-500 hover:text-white transition-colors cursor-pointer">@${safeName}</span>`;
    });
    escaped = escaped.replace(/&lt;#(\d+)&gt;/g, (_, id) => {
      const ch = guild.channels.cache.get(id);
      const safeName = escapeHtml(ch ? ch.name : 'salon-inconnu');
      return `<span class="dc-mention font-semibold text-sky-400 px-1.5 py-0.5 bg-sky-500/10 rounded hover:bg-sky-500 hover:text-white transition-colors cursor-pointer">#${safeName}</span>`;
    });
    escaped = escaped.replace(/&lt;@&amp;(\d+)&gt;/g, (_, id) => {
      const role = guild.roles.cache.get(id);
      const safeName = escapeHtml(role ? role.name : 'rôle-inconnu');
      return `<span class="dc-mention font-semibold text-sky-400 px-1.5 py-0.5 bg-sky-500/10 rounded hover:bg-sky-500 hover:text-white transition-colors cursor-pointer">@${safeName}</span>`;
    });
  } else {
    escaped = escaped.replace(/&lt;@!?(\d+)&gt;/g, '<span class="dc-mention font-semibold text-sky-400 px-1.5 py-0.5 bg-sky-500/10 rounded cursor-pointer">@Utilisateur</span>');
    escaped = escaped.replace(/&lt;#(\d+)&gt;/g, '<span class="dc-mention font-semibold text-sky-400 px-1.5 py-0.5 bg-sky-500/10 rounded cursor-pointer">#salon</span>');
    escaped = escaped.replace(/&lt;@&amp;(\d+)&gt;/g, '<span class="dc-mention font-semibold text-sky-400 px-1.5 py-0.5 bg-sky-500/10 rounded cursor-pointer">@Rôle</span>');
  }

  return escaped;
}

export function extractMediaUrls(content: string): { type: 'image' | 'video' | 'audio', url: string }[] {
  if (!content) return [];
  const urls: { type: 'image' | 'video' | 'audio', url: string }[] = [];
  const regex = /(https?:\/\/[^\s]+)/g;
  const matches = content.match(regex);
  if (matches) {
    for (const url of matches) {
      const cleanUrl = url.split('?')[0];
      if (/\.(gif|jpg|jpeg|png|webp)/i.test(cleanUrl)) {
        urls.push({ type: 'image', url });
      } else if (/\.(mp4|webm|mov|ogg)/i.test(cleanUrl)) {
        urls.push({ type: 'video', url });
      } else if (/\.(mp3|wav|ogg|flac|m4a)/i.test(cleanUrl)) {
        urls.push({ type: 'audio', url });
      } else if (/giphy\.com\/gifs\//i.test(cleanUrl)) {
        const parts = cleanUrl.split('-');
        const id = parts.at(-1);
        if (id) {
          urls.push({ type: 'image', url: `https://media.giphy.com/media/${id}/giphy.gif` });
        }
      }
    }
  }
  return urls;
}
