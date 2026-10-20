/**
 * Salon « Image du jour » : chaque membre y poste l'image qu'il trouve la
 * meilleure du jour, une seule, de 00:00 à 23:59 à l'heure du serveur.
 *
 * Pas de table : à chaque image, le bot relit les messages du jour du salon.
 * Un redémarrage ne perd rien, et un membre qui supprime son image peut en
 * poster une autre.
 */
import { type Message, PermissionFlagsBits } from 'discord.js';
import { BucketZoner } from '../analytics/zonedBuckets.js';
import { resolveGuildTimezone } from '../../utils/timezone.js';

const IMAGE_URL = /https?:\/\/\S+\.(?:png|jpe?g|gif|webp|avif)(?:\?\S*)?(?:\s|$)/i;
const NOTICE_MS = 6000;
// shortcut: 5 pages de 100 messages par jour au plus, au-delà un doublon peut passer ; paginer plus si un serveur dépasse.
const MAX_PAGES = 5;

type ImageCarrier = Pick<Message, 'content'> & {
  attachments: { some(fn: (a: { contentType: string | null }) => boolean): boolean };
  embeds: Array<{ data: { type?: string } }>;
};

/** Une pièce jointe image, un lien direct vers une image, ou un embed image/GIF. */
export function hasImage(message: ImageCarrier): boolean {
  if (message.attachments.some((a) => !!a.contentType?.startsWith('image/'))) return true;
  if (message.embeds.some((e) => e.data.type === 'image' || e.data.type === 'gifv')) return true;
  return IMAGE_URL.test(`${message.content} `);
}

async function notify(message: Message, text: string): Promise<void> {
  if (!message.channel.isSendable()) return;
  const notice = await message.channel.send({ content: text, allowedMentions: { users: [message.author.id] } }).catch(() => null);
  if (notice) setTimeout(() => notice.delete().catch(() => null), NOTICE_MS);
}

/** L'auteur a-t-il déjà une autre image dans le salon aujourd'hui ? */
async function alreadyPostedToday(message: Message, zoner: BucketZoner, today: string): Promise<boolean> {
  let before: string | undefined = message.id;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await message.channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || batch.size === 0) return false;
    for (const previous of batch.values()) {
      if (zoner.fromDate(previous.createdAt).dateKey !== today) return false;
      if (previous.author.id === message.author.id && hasImage(previous)) return true;
    }
    before = batch.last()?.id;
  }
  return false;
}

export async function handleImageOfDayMessage(message: Message, guildId: string): Promise<void> {
  // Le staff peut annoncer un thème ou répondre sans être filtré.
  if (message.member?.permissionsIn(message.channelId).has(PermissionFlagsBits.ManageMessages)) return;

  if (!hasImage(message)) {
    await message.delete().catch(() => null);
    await notify(message, `❌ ${message.author}, ici on ne poste qu'une image : ton image du jour.`);
    return;
  }

  const zoner = new BucketZoner(await resolveGuildTimezone(guildId));
  if (await alreadyPostedToday(message, zoner, zoner.fromDate(message.createdAt).dateKey)) {
    await message.delete().catch(() => null);
    await notify(message, `❌ ${message.author}, tu as déjà posté ton image du jour. Reviens demain !`);
  }
}
