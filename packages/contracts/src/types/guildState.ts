/**
 * Formes que l'API du bot envoie au dashboard pour decrire un serveur.
 *
 * Elles vivaient dans api/shared/core.ts, hors de portee du dashboard, qui
 * tenait donc les memes listes en `any[]` dans son store : salons, roles,
 * regles du reglement, catalogue de commandes. Ces valeurs sont lues par des
 * dizaines d'ecrans, et rien ne signalait qu'un champ avait disparu de la
 * reponse.
 *
 * Le bot continue de les reexporter depuis core.ts : ses modules ne changent
 * pas d'import.
 */

/**
 * Salon, categorie ou salon vocal propose dans les selecteurs.
 *
 * `mention` est la forme `<#id>` prete a coller dans un message : la calculer
 * cote serveur evite que chaque ecran la reconstruise a sa facon.
 */
export type DashboardChannel = {
  id: string;
  name: string;
  mention: string;
  type?: 'text' | 'announcement' | 'voice' | 'forum' | 'media' | 'thread';
};

/** Une regle du reglement du serveur. */
export type RegulationRuleItem = {
  id: string;
  title: string;
  description: string;
  emoji: string | null;
  sortOrder: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

/**
 * Restriction posee sur une commande.
 *
 * Les listes d'autorisation l'emportent sur celles d'interdiction seulement
 * quand elles sont non vides ; `enabled` a faux ferme la commande a tout le
 * monde, administrateurs compris.
 */
export type CommandRestrictionRule = {
  commandName: string;
  enabled: boolean;
  allowedChannelIds: string[];
  blockedChannelIds: string[];
  allowedRoleIds: string[];
  blockedRoleIds: string[];
  allowedUserIds: string[];
  blockedUserIds: string[];
};

/** Une commande du catalogue, telle que la page des droits l'affiche. */
export type CommandCatalogEntry = {
  name: string;
  label: string;
  description: string;
  defaultAccess: 'tout_le_monde' | 'modération' | 'administration';
  category?: string;
  options?: unknown[];
};

/** Series d'activite du serveur, pour les graphiques de l'accueil. */
export type GuildAnalyticsData = {
  activityTrend: number[];
  messagesTrend: number[];
  voiceTrend: number[];
  joinsTrend: number[];
  leavesTrend: number[];
  sanctionsTrend: number[];
  totalAutomations: number;
  healthStatus: number;
};

/** Gravite retenue pour un module dans le journal du serveur. */
export type SeverityLevel = 'off' | 'info' | 'attention' | 'critique';

/** Gravite par module, telle que la page des journaux la regle. */
export type ModuleSeverity = {
  module: string;
  level: SeverityLevel;
};

/**
 * Une ligne du journal d'audit.
 *
 * `source` dit d'ou vient l'action : une commande Discord ou le dashboard.
 * La fusion incrementale du store se fie a `id`, et retombe sur le triplet
 * date/auteur/action pour les entrees anciennes qui n'en ont pas.
 */
export type AuditEntry = {
  id: string;
  user: string;
  action: string;
  context: string;
  module: string;
  eventType: string;
  source: 'dashboard' | 'discord';
  details: string;
  dateIso: string;
  channelId: string | null;
};

/** Un palier d'une grille de sanctions. */
export type SanctionTableTier = {
  id: string;
  level: number;
  action: string;
  durationSeconds: number | null;
  /** Gravite du warn d'un palier WARN (0 = rappel). */
  weight: number;
  customReason: string | null;
};

/** Une grille de sanctions du serveur. */
export type SanctionTable = {
  id: string;
  name: string;
  tiers: SanctionTableTier[];
};
