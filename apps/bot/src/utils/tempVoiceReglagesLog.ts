import { EmbedBuilder } from 'discord.js';
import * as m from '../lib/paraglide/messages.js';
import type { BotLocale } from './i18n.js';

/** Limites d'un embed Discord, avec de la marge : champ 1024, total 6000, 25 champs. */
const CHAMP_MAX = 1000;
const TOTAL_MAX = 5300;
const CHAMPS_MAX = 25;

/**
 * Embed des changements de réglages vocaux faits depuis le dashboard.
 * `lignes` : « champ : avant → après », déjà dans la langue du serveur. Découpées
 * en champs de 1000 caractères ; au-delà du plafond de l'embed, une phrase dit
 * combien de lignes restent dans l'audit (qui, lui, garde tout). Rend `null`
 * quand il n'y a rien à dire.
 */
export function construireEmbedReglagesVocaux(lignes: readonly string[], par: string, locale: BotLocale): EmbedBuilder | null {
  if (lignes.length === 0) return null;
  const L = { locale };
  const nomChamp = m.log_voicecfg_field_changes({}, L);
  const blocs: string[] = [];
  let courant = '';
  let total = par.length + m.log_voicecfg_field_by({}, L).length;
  let gardees = 0;
  for (const brute of lignes) {
    const ligne = brute.length > CHAMP_MAX ? `${brute.slice(0, CHAMP_MAX - 1)}…` : brute;
    const suite = courant ? `${courant}\n${ligne}` : ligne;
    const nouveauBloc = suite.length > CHAMP_MAX;
    if (total + ligne.length + 1 > TOTAL_MAX || (nouveauBloc && blocs.length >= CHAMPS_MAX - 3)) break;
    if (nouveauBloc) { blocs.push(courant); courant = ligne; } else courant = suite;
    total += ligne.length + 1;
    gardees++;
  }
  if (courant) blocs.push(courant);
  const reste = lignes.length - gardees;
  if (reste > 0) blocs.push(m.log_voicecfg_more({ n: reste }, L));

  const embed = new EmbedBuilder()
    .setColor(0x457b9d)
    .setTitle(m.log_voicecfg_title({}, L))
    .addFields({ name: m.log_voicecfg_field_by({}, L), value: par.slice(0, CHAMP_MAX), inline: false })
    .setFooter({ text: m.log_tempvoice_footer({ tag: par }, L) })
    .setTimestamp();
  blocs.forEach((value, i) => embed.addFields({
    name: blocs.length > 1 ? m.log_voicecfg_field_changes_n({ n: i + 1 }, L) : nomChamp,
    value,
  }));
  return embed;
}
