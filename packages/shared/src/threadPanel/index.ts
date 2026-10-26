/**
 * Panneaux de discussion : un message avec des boutons, chacun ouvre un fil
 * public, un fil privé ou un post de forum après un formulaire.
 *
 * Le bot crée les fils selon ces règles, le dashboard les édite et montre
 * l'aperçu du nom : un seul contrat évite que les deux divergent. Tout ici
 * est pur (pas de discord.js).
 */

// ── Vocabulaire ─────────────────────────────────────────────────────────────

export const THREAD_PANEL_TARGETS = ['public', 'private', 'forum'] as const;
export type ThreadPanelTarget = (typeof THREAD_PANEL_TARGETS)[number];

export const THREAD_PANEL_BUTTON_STYLES = ['primary', 'secondary', 'success', 'danger'] as const;
export type ThreadPanelButtonStyle = (typeof THREAD_PANEL_BUTTON_STYLES)[number];

export const THREAD_PANEL_FIELD_STYLES = ['short', 'paragraph'] as const;
export type ThreadPanelFieldStyle = (typeof THREAD_PANEL_FIELD_STYLES)[number];

/** Durées d'archivage que Discord accepte, en minutes. */
export const THREAD_PANEL_ARCHIVE_MINUTES = [60, 1440, 4320, 10080] as const;

/** Délais du mode lent que Discord accepte pour un fil, en secondes. */
export const THREAD_PANEL_SLOWMODE_SECONDS = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600] as const;

export const THREAD_PANEL_PLACEHOLDERS = ['{title}', '{user}', '{username}', '{count}', '{date}'] as const;
export const THREAD_PANEL_STARTER_PLACEHOLDERS = ['{user}', '{title}', '{answers}', '{count}'] as const;

export const THREAD_PANEL_LIMITS = {
  panelsPerGuild: 25,
  buttonsPerPanel: 10,
  /** Un modal Discord porte 5 composants : le titre en prend un. */
  modalComponents: 5,
  name: 80,
  title: 256,
  description: 2000,
  buttonLabel: 80,
  emoji: 64,
  fieldLabel: 45,
  fieldPlaceholder: 100,
  fieldMaxLength: 4000,
  nameTemplate: 100,
  starterMessage: 2000,
  roleIds: 25,
  tagIds: 5,
  /** Plafond de Discord pour un menu de tags dans un modal. */
  choiceTagIds: 25,
  maxOpenPerMember: 50,
  cooldownMaxSeconds: 7 * 24 * 3600,
  claimMaxDays: 365,
  threadName: 100,
} as const;

export interface ThreadPanelField {
  id: string;
  label: string;
  placeholder: string;
  style: ThreadPanelFieldStyle;
  required: boolean;
  maxLength: number;
}

export interface ThreadPanelButton {
  id: string;
  label: string;
  emoji: string | null;
  style: ThreadPanelButtonStyle;
  target: ThreadPanelTarget;
  /** Salon où ouvrir le fil. Vide : le salon du panneau (forum : obligatoire). */
  targetChannelId: string | null;
  titleLabel: string;
  titlePlaceholder: string;
  fields: ThreadPanelField[];
  nameTemplate: string;
  /** Vide : message par défaut (mention de l'auteur et réponses). */
  starterMessage: string;
  archiveMinutes: number;
  slowmodeSeconds: number;
  /** 0 : pas de limite. */
  maxOpenPerMember: number;
  cooldownSeconds: number;
  /** Vide : tout le monde peut cliquer. */
  allowedRoleIds: string[];
  /** Mentionnés à l'ouverture ; dans un fil privé, la mention les y ajoute. */
  mentionRoleIds: string[];
  /** Forum : tags posés d'office. */
  forumTagIds: string[];
  /** Forum : tags que le membre choisit dans le formulaire. */
  forumChoiceTagIds: string[];
  /** Forum : tag posé par « Résolu ». */
  resolvedTagId: string | null;
  /** Fil privé : annonce dans le salon avec un bouton « Demander à rejoindre ». */
  joinRequests: boolean;
  /** Réclamer un fil dont l'auteur n'a rien écrit depuis N jours. 0 : seulement s'il a quitté le serveur. */
  claimAfterDays: number;
}

export interface ThreadPanelData {
  name: string;
  enabled: boolean;
  title: string;
  description: string;
  /** Couleur de l'encadré, `#rrggbb`. */
  color: string;
  imageUrl: string | null;
  /** Salon des journaux de création et d'actions. Vide : aucun journal. */
  logChannelId: string | null;
  buttons: ThreadPanelButton[];
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function defaultThreadPanelButton(): ThreadPanelButton {
  return {
    id: randomId(),
    label: 'Créer un fil',
    emoji: null,
    style: 'primary',
    target: 'public',
    targetChannelId: null,
    titleLabel: 'Titre',
    titlePlaceholder: '',
    fields: [],
    nameTemplate: '{title}',
    starterMessage: '',
    archiveMinutes: 1440,
    slowmodeSeconds: 0,
    maxOpenPerMember: 0,
    cooldownSeconds: 0,
    allowedRoleIds: [],
    mentionRoleIds: [],
    forumTagIds: [],
    forumChoiceTagIds: [],
    resolvedTagId: null,
    joinRequests: false,
    claimAfterDays: 0,
  };
}

export function defaultThreadPanel(): ThreadPanelData {
  return {
    name: 'Panneau de discussion',
    enabled: true,
    title: 'Ouvrir une discussion',
    description: 'Clique sur le bouton ci-dessous pour ouvrir un fil.',
    color: '#5865f2',
    imageUrl: null,
    logChannelId: null,
    buttons: [defaultThreadPanelButton()],
  };
}

/** Champs libres autorisés : le menu de tags prend une place du modal. */
export function maxThreadPanelFields(button: Pick<ThreadPanelButton, 'target' | 'forumChoiceTagIds'>): number {
  const tagMenu = button.target === 'forum' && button.forumChoiceTagIds.length > 0 ? 1 : 0;
  return THREAD_PANEL_LIMITS.modalComponents - 1 - tagMenu;
}

// ── Validation ──────────────────────────────────────────────────────────────

/** Codes d'erreur : le dashboard les traduit, l'API les rend en clair. */
export type ThreadPanelError =
  | 'name_required'
  | 'title_required'
  | 'buttons_required'
  | 'buttons_too_many'
  | 'button_label_required'
  | 'fields_too_many'
  | 'field_label_required'
  | 'forum_channel_required'
  | 'image_url_invalid';

export type ThreadPanelResult = { ok: true; value: ThreadPanelData } | { ok: false; error: ThreadPanelError };

function pick<T extends string | number>(list: readonly T[], raw: unknown, fallback: T): T {
  return (list as readonly unknown[]).includes(raw) ? (raw as T) : fallback;
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function text(raw: unknown, max: number): string {
  return typeof raw === 'string' ? raw.trim().slice(0, max) : '';
}

const SNOWFLAKE = /^\d{17,20}$/;
const SHORT_ID = /^[a-z0-9]{4,16}$/;

function snowflake(raw: unknown): string | null {
  return typeof raw === 'string' && SNOWFLAKE.test(raw) ? raw : null;
}

function snowflakes(raw: unknown, max: number): string[] {
  const ids = (Array.isArray(raw) ? raw : []).filter((id): id is string => typeof id === 'string' && SNOWFLAKE.test(id));
  return [...new Set(ids)].slice(0, max);
}

/** Garde l'identifiant existant : les fils déjà ouverts y sont rattachés. */
function stableId(raw: unknown, taken: Set<string>): string {
  let id = typeof raw === 'string' && SHORT_ID.test(raw) && !taken.has(raw) ? raw : randomId();
  while (taken.has(id)) id = randomId();
  taken.add(id);
  return id;
}

function normalizeField(raw: unknown, taken: Set<string>): ThreadPanelField | ThreadPanelError {
  const node = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const label = text(node.label, THREAD_PANEL_LIMITS.fieldLabel);
  if (!label) return 'field_label_required';
  return {
    id: stableId(node.id, taken),
    label,
    placeholder: text(node.placeholder, THREAD_PANEL_LIMITS.fieldPlaceholder),
    style: pick(THREAD_PANEL_FIELD_STYLES, node.style, 'paragraph'),
    required: node.required === true,
    maxLength: clampInt(node.maxLength, 1, THREAD_PANEL_LIMITS.fieldMaxLength, 1000),
  };
}

function normalizeButton(raw: unknown, taken: Set<string>): ThreadPanelButton | ThreadPanelError {
  const node = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const base = defaultThreadPanelButton();

  const label = text(node.label, THREAD_PANEL_LIMITS.buttonLabel);
  if (!label) return 'button_label_required';

  const target = pick(THREAD_PANEL_TARGETS, node.target, base.target);
  const targetChannelId = snowflake(node.targetChannelId);
  if (target === 'forum' && !targetChannelId) return 'forum_channel_required';

  const forumChoiceTagIds = target === 'forum' ? snowflakes(node.forumChoiceTagIds, THREAD_PANEL_LIMITS.choiceTagIds) : [];
  const rawFields = Array.isArray(node.fields) ? node.fields : [];
  if (rawFields.length > maxThreadPanelFields({ target, forumChoiceTagIds })) return 'fields_too_many';
  const fieldIds = new Set<string>();
  const fields: ThreadPanelField[] = [];
  for (const rawField of rawFields) {
    const field = normalizeField(rawField, fieldIds);
    if (typeof field === 'string') return field;
    fields.push(field);
  }

  return {
    id: stableId(node.id, taken),
    label,
    emoji: text(node.emoji, THREAD_PANEL_LIMITS.emoji) || null,
    style: pick(THREAD_PANEL_BUTTON_STYLES, node.style, base.style),
    target,
    targetChannelId,
    titleLabel: text(node.titleLabel, THREAD_PANEL_LIMITS.fieldLabel) || base.titleLabel,
    titlePlaceholder: text(node.titlePlaceholder, THREAD_PANEL_LIMITS.fieldPlaceholder),
    fields,
    nameTemplate: text(node.nameTemplate, THREAD_PANEL_LIMITS.nameTemplate) || base.nameTemplate,
    starterMessage: text(node.starterMessage, THREAD_PANEL_LIMITS.starterMessage),
    archiveMinutes: pick(THREAD_PANEL_ARCHIVE_MINUTES, Number(node.archiveMinutes), base.archiveMinutes as 1440),
    slowmodeSeconds: pick(THREAD_PANEL_SLOWMODE_SECONDS, Number(node.slowmodeSeconds), 0),
    maxOpenPerMember: clampInt(node.maxOpenPerMember, 0, THREAD_PANEL_LIMITS.maxOpenPerMember, 0),
    cooldownSeconds: clampInt(node.cooldownSeconds, 0, THREAD_PANEL_LIMITS.cooldownMaxSeconds, 0),
    allowedRoleIds: snowflakes(node.allowedRoleIds, THREAD_PANEL_LIMITS.roleIds),
    mentionRoleIds: snowflakes(node.mentionRoleIds, THREAD_PANEL_LIMITS.roleIds),
    forumTagIds: target === 'forum' ? snowflakes(node.forumTagIds, THREAD_PANEL_LIMITS.tagIds) : [],
    forumChoiceTagIds,
    resolvedTagId: target === 'forum' ? snowflake(node.resolvedTagId) : null,
    joinRequests: target === 'private' && node.joinRequests === true,
    claimAfterDays: clampInt(node.claimAfterDays, 0, THREAD_PANEL_LIMITS.claimMaxDays, 0),
  };
}

/** Valide un panneau venu du dashboard ou de la base. */
export function normalizeThreadPanel(raw: unknown): ThreadPanelResult {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const base = defaultThreadPanel();

  const name = text(input.name, THREAD_PANEL_LIMITS.name);
  if (!name) return { ok: false, error: 'name_required' };
  const title = text(input.title, THREAD_PANEL_LIMITS.title);
  if (!title) return { ok: false, error: 'title_required' };

  let imageUrl: string | null = null;
  if (typeof input.imageUrl === 'string' && input.imageUrl.trim()) {
    imageUrl = input.imageUrl.trim();
    if (!/^https:\/\/\S+$/i.test(imageUrl) || imageUrl.length > 500) return { ok: false, error: 'image_url_invalid' };
  }

  const rawButtons = Array.isArray(input.buttons) ? input.buttons : [];
  if (rawButtons.length === 0) return { ok: false, error: 'buttons_required' };
  if (rawButtons.length > THREAD_PANEL_LIMITS.buttonsPerPanel) return { ok: false, error: 'buttons_too_many' };
  const taken = new Set<string>();
  const buttons: ThreadPanelButton[] = [];
  for (const rawButton of rawButtons) {
    const button = normalizeButton(rawButton, taken);
    if (typeof button === 'string') return { ok: false, error: button };
    buttons.push(button);
  }

  return {
    ok: true,
    value: {
      name,
      enabled: input.enabled !== false,
      title,
      description: typeof input.description === 'string' ? input.description.trim().slice(0, THREAD_PANEL_LIMITS.description) : base.description,
      color: typeof input.color === 'string' && /^#[0-9a-f]{6}$/i.test(input.color) ? input.color.toLowerCase() : base.color,
      imageUrl,
      logChannelId: snowflake(input.logChannelId),
      buttons,
    },
  };
}

// ── Nom du fil et message de départ ─────────────────────────────────────────

export interface ThreadPanelVars {
  title: string;
  displayName: string;
  username: string;
  count: number;
  date: Date;
}

function fill(template: string, vars: ThreadPanelVars, locale: 'fr' | 'en'): string {
  return template
    .replaceAll('{title}', vars.title)
    .replaceAll('{user}', vars.displayName)
    .replaceAll('{username}', vars.username)
    .replaceAll('{count}', String(vars.count))
    .replaceAll('{date}', vars.date.toLocaleDateString(locale === 'fr' ? 'fr-FR' : 'en-US', { timeZone: 'UTC' }));
}

/** Nom du fil : modèle rempli, ramené sur une ligne et à 100 caractères. */
export function buildThreadPanelName(
  button: Pick<ThreadPanelButton, 'nameTemplate'>,
  vars: ThreadPanelVars,
  locale: 'fr' | 'en' = 'fr',
): string {
  const name = fill(button.nameTemplate, vars, locale).trim() || vars.title.trim() || vars.displayName;
  return name.replace(/\s+/g, ' ').trim().slice(0, THREAD_PANEL_LIMITS.threadName);
}

export interface ThreadPanelAnswer {
  label: string;
  value: string;
}

/** Réponses du formulaire en Markdown, sans les champs laissés vides. */
export function formatThreadPanelAnswers(answers: ThreadPanelAnswer[]): string {
  return answers
    .filter((answer) => answer.value.trim())
    .map((answer) => `**${answer.label}**\n${answer.value.trim()}`)
    .join('\n\n');
}

/**
 * Message de départ. `{user}` y est une mention, pas le pseudo : c'est elle
 * qui fait entrer l'auteur dans un fil privé.
 */
export function buildThreadPanelStarter(
  button: Pick<ThreadPanelButton, 'starterMessage'>,
  input: { userMention: string; title: string; answers: ThreadPanelAnswer[]; count: number },
): string {
  const answers = formatThreadPanelAnswers(input.answers);
  const template = button.starterMessage || (answers ? '{user}\n\n{answers}' : '{user}');
  return template
    .replaceAll('{user}', input.userMention)
    .replaceAll('{title}', input.title)
    .replaceAll('{answers}', answers)
    .replaceAll('{count}', String(input.count))
    .slice(0, 2000);
}

/**
 * Délai restant avant que le membre puisse rouvrir un fil, en secondes. 0 :
 * il peut.
 */
export function threadPanelCooldownLeft(cooldownSeconds: number, lastCreatedAt: Date | null, now: Date): number {
  if (!cooldownSeconds || !lastCreatedAt) return 0;
  const elapsed = Math.floor((now.getTime() - lastCreatedAt.getTime()) / 1000);
  return Math.max(0, cooldownSeconds - elapsed);
}
