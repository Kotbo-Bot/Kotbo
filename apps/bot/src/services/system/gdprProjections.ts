/**
 * Projections de l'export RGPD : ce qu'une ligne devient avant d'être remise à
 * la personne qui en fait la demande.
 *
 * Le droit d'accès ne doit pas livrer les données des autres. Une ligne qui
 * réunit plusieurs membres (un concours et tous ses participants, un
 * signalement et son auteur) n'est exportée qu'après en avoir retiré ce qui ne
 * concerne pas la personne.
 */

type GdprRecord = Record<string, unknown>;

/** Projection appliquée à chaque ligne d'une source, avec l'identifiant de la personne. */
export type GdprProjection = (record: GdprRecord, discordId: string) => unknown;

function includesId(value: unknown, discordId: string): boolean {
  return Array.isArray(value) && value.includes(discordId);
}

/** Concours : la participation de la personne, sans la liste des autres participants. */
export const projectGiveaway: GdprProjection = (record, discordId) => {
  const { participants, winners, pendingWinners, ...giveaway } = record;
  return {
    ...giveaway,
    participated: includesId(participants, discordId),
    won: includesId(winners, discordId),
    pendingWinner: includesId(pendingWinners, discordId),
  };
};

/** Signalement visant la personne : l'auteur reste anonyme, comme il l'était pour elle. */
export const projectMemberReport: GdprProjection = (record, discordId) =>
  (record.reporterId === discordId ? record : { ...record, reporterId: null });

/** Clé MCP : l'empreinte du secret ne sert qu'à l'authentification, elle ne sort pas. */
export const projectMcpApiKey: GdprProjection = (record) => {
  const { keyHash: _keyHash, ...key } = record;
  return key;
};
