import { OverwriteType, PermissionFlagsBits, type VoiceChannel } from 'discord.js';
import { categoryOverwriteFor, restoreFromCategory } from '../services/features/tempVoiceService.js';

/** Qui voit le salon : tout le monde, ceux qui y ont accès, le propriétaire et ses invités. */
export type Visibilite = 'tous' | 'acces' | 'prive';

const VALEURS: readonly Visibilite[] = ['tous', 'acces', 'prive'];

export function normaliserVisibilite(v: unknown, defaut: Visibilite = 'tous'): Visibilite {
  return VALEURS.includes(v as Visibilite) ? (v as Visibilite) : defaut;
}

/** Pure : un bloqué (= banni) gagne toujours, même autorisé ou porteur d'un rôle d'office. */
export function planVisibilite(p: {
  visibilite: Visibilite;
  verrouille: boolean;
  everyoneId: string;
  proprietaireId: string;
  autorises: string[];
  bloques: string[];
  rolesOffice: string[];
}): { everyoneVoit: boolean; voient: string[]; nevoientPas: string[] } {
  const everyoneVoit = p.visibilite === 'tous' || (p.visibilite === 'acces' && !p.verrouille);
  const nevoientPas = [...new Set(p.bloques)];
  const voient = everyoneVoit
    ? []
    : [...new Set([p.proprietaireId, ...p.autorises, ...p.rolesOffice])]
      .filter((id) => id !== p.everyoneId && !nevoientPas.includes(id));
  return { everyoneVoit, voient, nevoientPas };
}

type Lue = { allow?: { has(bit: bigint): boolean }; deny?: { has(bit: bigint): boolean }; type?: number };

/** Membres nominatifs du salon (hors @everyone, propriétaire, bot), comme lireEtatSalon. */
function membresSurcharges(channel: VoiceChannel, proprietaireId: string): Array<[string, Lue]> {
  const everyoneId = channel.guild?.id ?? '';
  const botId = channel.guild?.members?.me?.id ?? '';
  const sortie: Array<[string, Lue]> = [];
  for (const [id, s] of (channel.permissionOverwrites?.cache ?? []) as Iterable<[string, Lue]>) {
    if (id === everyoneId || id === proprietaireId || id === botId) continue;
    if (s.type !== undefined && s.type !== OverwriteType.Member) continue;
    sortie.push([id, s]);
  }
  return sortie;
}

/** Comme estAutorise : allow Connect sans deny ViewChannel. */
export function autorisesDuSalon(channel: VoiceChannel, proprietaireId: string): string[] {
  return membresSurcharges(channel, proprietaireId)
    .filter(([, s]) => !s.deny?.has(PermissionFlagsBits.ViewChannel) && s.allow?.has(PermissionFlagsBits.Connect))
    .map(([id]) => id);
}

/** Comme estBanni : deny ViewChannel. */
export function bloquesDuSalon(channel: VoiceChannel): string[] {
  return membresSurcharges(channel, '')
    .filter(([, s]) => s.deny?.has(PermissionFlagsBits.ViewChannel))
    .map(([id]) => id);
}

export async function appliquerVisibilite(
  channel: VoiceChannel,
  visibilite: Visibilite,
  ctx: { proprietaireId: string; rolesOffice: string[] },
): Promise<void> {
  const cache = channel.permissionOverwrites?.cache;
  const everyoneId = channel.guild?.id ?? '';
  const verrouille = Boolean(cache?.get(everyoneId)?.deny?.has(PermissionFlagsBits.Connect));
  const plan = planVisibilite({
    visibilite, verrouille, everyoneId, proprietaireId: ctx.proprietaireId,
    autorises: autorisesDuSalon(channel, ctx.proprietaireId),
    bloques: bloquesDuSalon(channel),
    rolesOffice: ctx.rolesOffice,
  });

  // État actuel du seul bit ViewChannel ; on n'écrit que ce qui change.
  const actuel = (id: string): boolean | null => {
    const s = cache?.get(id) as Lue | undefined;
    if (s?.deny?.has(PermissionFlagsBits.ViewChannel)) return false;
    return s?.allow?.has(PermissionFlagsBits.ViewChannel) ? true : null;
  };
  const poser = async (id: string, voit: boolean | null, type: OverwriteType) => {
    if (actuel(id) === voit) return;
    await channel.permissionOverwrites.edit(id, { ViewChannel: voit }, { type });
  };

  // Caché = refus explicite (null ne masquerait rien).
  // Visible = ce que porte la catégorie, pas `null` (Discord ne la relit pas après la création).
  const voitParCategorie = (): boolean | null =>
    restoreFromCategory({ ViewChannel: null }, categoryOverwriteFor(channel, everyoneId)).ViewChannel;
  if (everyoneId) await poser(everyoneId, plan.everyoneVoit ? voitParCategorie() : false, OverwriteType.Role);
  for (const id of plan.voient) {
    await poser(id, true, ctx.rolesOffice.includes(id) ? OverwriteType.Role : OverwriteType.Member);
  }
  for (const id of plan.nevoientPas) await poser(id, false, OverwriteType.Member);
}
