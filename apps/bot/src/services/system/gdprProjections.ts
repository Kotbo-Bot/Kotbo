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

/** Identifiants de la personne : son ID Discord, et ses fiches staff en plus. */
export interface GdprIds {
  discordId: string;
  staffIds: string[];
}

/** Projection appliquée à chaque ligne d'une source. */
export type GdprProjection = (record: GdprRecord, ids: GdprIds) => unknown;

/** Une table interrogée par l'export. */
export interface GdprSource {
  category: string;
  key: string;
  label: string;
  /** Nom d'accès du modèle sur le client Prisma. */
  model: string;
  /** Construit la clause `where` à partir des identifiants recherchés. */
  where: (ids: GdprIds) => Record<string, unknown>;
  /** Retire d'une ligne ce qui concerne d'autres membres. */
  project?: GdprProjection;
}

/**
 * Listes de membres (participants, votants...) : chacune est remplacée par sa
 * taille et par la présence de la personne, sous le nom donné.
 */
export function projectListMembership(flags: Record<string, string>): GdprProjection {
  return (record, { discordId }) => {
    const projected: GdprRecord = { ...record };
    for (const [field, flag] of Object.entries(flags)) {
      const list = Array.isArray(record[field]) ? record[field] as unknown[] : [];
      delete projected[field];
      projected[`${field}Count`] = list.length;
      projected[flag] = list.includes(discordId);
    }
    return projected;
  };
}

/** Signalement visant la personne : l'auteur reste anonyme, comme il l'était pour elle. */
export const projectMemberReport: GdprProjection = (record, { discordId }) =>
  (record.reporterId === discordId ? record : { ...record, reporterId: null });

/**
 * Exclusion de la progression : la ligne est la configuration entière du
 * serveur, seul le fait d'être exclu concerne la personne.
 */
export const projectProgressionBlacklist: GdprProjection = (record) => ({
  guildId: record.id ?? null,
  progressionBlacklisted: true,
});

/** Clé MCP : l'empreinte du secret ne sert qu'à l'authentification, elle ne sort pas. */
export const projectMcpApiKey: GdprProjection = (record) => {
  const { keyHash: _keyHash, ...key } = record;
  return key;
};

/**
 * Champs qui gardent l'auteur d'une action d'administration ou de staff
 * (« créé par », « décidé par »...). La ligne qui les porte décrit d'abord un
 * autre membre ou un réglage du serveur : seule une trace en est exportée.
 */
export const ACTOR_FIELDS: readonly string[] = [
  'acceptedByUsUserId', 'actorId', 'actorUserId', 'addedBy', 'addedByUserId', 'appealLockedByUserId',
  'approvedByUserId', 'archivedById', 'archivedByUserId', 'authorUserId', 'bannedBy', 'cancelledBy',
  'claimedById', 'closedById', 'completedByUserId', 'createdBy', 'createdById', 'createdByUserId',
  'decidedBy', 'decidedByUserId', 'decisionByUserId', 'deletedBy', 'deletionLockedById',
  'dismissedByUserId', 'endedByUserId', 'evaluatorId', 'executedById', 'executorId', 'grantedBy',
  'grantedById', 'handledBy', 'handledById', 'ingestedBy', 'issuedByUserId', 'lastEditedById',
  'lastPostBy', 'linkedByUserId', 'lockedById', 'manualByUserId', 'mentorId', 'moderatorUserId',
  'processedByUserId', 'proposedByUserId', 'recordedByUserId', 'reportedByUserId', 'requestedByUserId',
  'resolvedBy', 'resolvedById', 'respondedById', 'revealedBy', 'reviewedById', 'secondApprovedByUserId',
  'sentBy', 'sentByUserId', 'serverTemplateAppliedBy', 'shieldChangedBy', 'superiorUserId',
  'suspendedById', 'trainingConsentById', 'unbannedBy', 'updatedBy', 'uploadedBy', 'uploadedById',
  'uploadedByUserId', 'validatedById',
];

/**
 * Trace d'une action : quoi (la ligne), où, quand, et à quel titre. Ni le
 * contenu ni la personne visée, qui appartiennent à d'autres.
 */
export function actionTrace(fields: readonly string[]): GdprProjection {
  return (record, { staffIds }) => ({
    id: record.id ?? null,
    guildId: record.guildId ?? null,
    createdAt: record.createdAt ?? null,
    updatedAt: record.updatedAt ?? null,
    as: fields.filter((field) => staffIds.includes(record[field] as string)),
  });
}

/** Pseudos recopiés à côté d'un identifiant : `moderatorUserId` → `moderatorTag`, `moderatorName`. */
function nameFieldsOf(field: string): string[] {
  const base = field.replace(/(UserId|Id)$/, '');
  return base === field ? [] : [`${base}Tag`, `${base}Name`];
}

/**
 * Sources où la personne est le sujet : l'identité du staff qui a agi sur la
 * ligne (modérateur, décideur, responsable du ticket...) est masquée, sauf
 * quand c'est la personne elle-même.
 *
 * Le droit d'accès porte sur les données de la personne, pas sur l'identité de
 * qui les a traitées pour le compte du serveur (CJUE, C-579/21, Pankki S,
 * 22 juin 2023). La nommer exposerait aussi le staff à des représailles, ce que
 * l'article 15 § 4 du RGPD demande d'éviter. La sanction, sa raison et ses
 * dates restent entières.
 */
export function maskingOtherActors(source: GdprSource): GdprSource {
  const project = source.project;
  return {
    ...source,
    project: (record, ids) => {
      const masked: GdprRecord = { ...record };
      for (const field of ACTOR_FIELDS) {
        const value = record[field];
        if (typeof value !== 'string' || ids.staffIds.includes(value)) continue;
        masked[field] = null;
        for (const name of nameFieldsOf(field)) {
          if (name in masked) masked[name] = null;
        }
      }
      return project ? project(masked, ids) : masked;
    },
  };
}

/** Ce que l'export lit d'un modèle Prisma (`Prisma.dmmf.datamodel.models`). */
export interface SchemaModel {
  name: string;
  fields: ReadonlyArray<{ name: string; type: string; isList: boolean }>;
}

/**
 * Une source de traces par modèle qui garde l'auteur d'une action. Générées
 * depuis le schéma : une table ajoutée avec un champ « créé par » est couverte
 * sans qu'on y pense.
 */
export function buildActionSources(models: readonly SchemaModel[], actorFields: readonly string[] = ACTOR_FIELDS): GdprSource[] {
  return models.flatMap((model) => {
    const fields = model.fields
      .filter((field) => field.type === 'String' && !field.isList && actorFields.includes(field.name))
      .map((field) => field.name);
    if (fields.length === 0) return [];

    const accessor = model.name.charAt(0).toLowerCase() + model.name.slice(1);
    return [{
      category: 'actions',
      key: `actions:${accessor}`,
      label: `Actions enregistrées (${model.name})`,
      model: accessor,
      // Les fiches staff sont incluses : certaines tables rangent l'auteur par sa fiche.
      where: ({ staffIds }: GdprIds) => ({ OR: fields.map((field) => ({ [field]: { in: staffIds } })) }),
      project: actionTrace(fields),
    }];
  });
}
