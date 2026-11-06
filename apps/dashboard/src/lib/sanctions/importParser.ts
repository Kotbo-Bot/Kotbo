import { m } from '../i18n';
/**
 * Parsing et normalisation des fichiers d'import de sanctions (JSON/CSV/XLSX)
 * exportes depuis d'autres bots de moderation (Sapphire, Mee6, Dyno,
 * RaidProtect...). Chaque bot a son propre format de colonnes ; plutot que de
 * coder un parseur par bot, on detecte le mapping le plus probable via des
 * intitules de colonnes courants, et l'utilisateur peut corriger manuellement
 * avant l'import.
 */

export type ParsedImportRow = Record<string, unknown>;

export type SanctionImportField =
  | 'type'
  | 'targetUserId'
  | 'targetTag'
  | 'moderatorUserId'
  | 'moderatorTag'
  | 'reason'
  | 'createdAt'
  | 'durationSeconds';

export const SANCTION_IMPORT_FIELDS: SanctionImportField[] = [
  'type', 'targetUserId', 'targetTag', 'moderatorUserId', 'moderatorTag', 'reason', 'createdAt', 'durationSeconds'
];

export type ColumnMapping = Partial<Record<SanctionImportField, string>>;

export type NormalizedImportRow = {
  type: string | null;
  targetUserId: string | null;
  targetTag: string | null;
  moderatorUserId: string | null;
  moderatorTag: string | null;
  reason: string;
  createdAt: string | null;
  durationSeconds: number | null;
  errors: string[];
};

const FIELD_HEADER_HINTS: Record<SanctionImportField, string[]> = {
  type: ['type', 'action', 'sanction', 'sanctiontype', 'punishment', 'casetype', 'punishmenttype'],
  targetUserId: ['userid', 'targetid', 'targetuserid', 'memberid', 'user id', 'discord id', 'discordid', 'target', 'victimid', 'id'],
  targetTag: ['username', 'user', 'tag', 'membertag', 'name', 'targetname', 'usertag', 'victim'],
  moderatorUserId: ['moderatorid', 'modid', 'staffid', 'executorid', 'responsableid'],
  moderatorTag: ['moderator', 'mod', 'staff', 'executor', 'moderatortag', 'responsable', 'issuer', 'author'],
  reason: ['reason', 'motif', 'description', 'raison', 'note'],
  createdAt: ['date', 'createdat', 'timestamp', 'time', 'issuedat', 'created', 'dateadded'],
  durationSeconds: ['duration', 'durationseconds', 'length', 'timeleft', 'temps'],
};

const DIACRITICS_RE = new RegExp('[̀-ͯ]', 'g');

function normalizeHeader(h: string): string {
  return h
    .toLowerCase()
    .normalize('NFD').replace(DIACRITICS_RE, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Devine le mapping colonne -> champ Kotbo a partir des intitules du fichier. */
export function guessColumnMapping(headers: string[]): ColumnMapping {
  const normalizedHeaders = headers.map((h) => ({ raw: h, norm: normalizeHeader(h) }));
  const mapping: ColumnMapping = {};

  for (const field of SANCTION_IMPORT_FIELDS) {
    const hints = FIELD_HEADER_HINTS[field];
    const match = normalizedHeaders.find((h) => hints.includes(h.norm));
    if (match) mapping[field] = match.raw;
  }

  return mapping;
}

const TYPE_ALIASES: Record<string, string> = {
  warn: 'WARN', warning: 'WARN', avertissement: 'WARN', avertir: 'WARN',
  kick: 'KICK', expulsion: 'KICK', expulser: 'KICK',
  mute: 'TIMEOUT', timeout: 'TIMEOUT', tempmute: 'TIMEOUT', temporarymute: 'TIMEOUT',
  tempban: 'TEMP_BAN', temporaryban: 'TEMP_BAN',
  ban: 'BAN', banned: 'BAN', permban: 'BAN', permanentban: 'BAN', bannissement: 'BAN',
  softban: 'SOFTBAN',
};

/** Normalise une valeur brute de type de sanction (ex: "Mute" -> "TIMEOUT"). */
export function normalizeSanctionType(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const key = String(raw).toLowerCase().trim().replace(/[\s_-]+/g, '');
  return TYPE_ALIASES[key] ?? null;
}

const SNOWFLAKE_RE = /\d{17,20}/;

/** Extrait un ID Discord (snowflake) d'une valeur brute, qui peut contenir du texte autour (ex: mention `<@123>`). */
export function extractSnowflake(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const match = String(raw).match(SNOWFLAKE_RE);
  return match ? match[0] : null;
}

const DURATION_UNIT_SECONDS: Record<string, number> = {
  s: 1, sec: 1, secs: 1, second: 1, seconds: 1, seconde: 1, secondes: 1,
  m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600, heure: 3600, heures: 3600,
  d: 86400, day: 86400, days: 86400, j: 86400, jour: 86400, jours: 86400,
  w: 604800, week: 604800, weeks: 604800, semaine: 604800, semaines: 604800,
};

/** Parse une duree en secondes depuis un nombre brut ou une chaine ("10m", "1d", "3600"). */
export function parseDurationToSeconds(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return raw > 0 ? Math.floor(raw) : null;

  const str = String(raw).trim().toLowerCase();
  if (!str || str === '0' || str === 'permanent' || str === 'perm' || str === 'never') return null;
  if (/^\d+$/.test(str)) return parseInt(str, 10);

  let total = 0;
  let matched = false;
  for (const m of str.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/g)) {
    const value = parseFloat(m[1]);
    const unit = DURATION_UNIT_SECONDS[m[2]];
    if (unit) {
      total += value * unit;
      matched = true;
    }
  }
  return matched ? Math.round(total) : null;
}

/** Parse une date depuis un ISO string, un timestamp unix (s/ms) ou un numero de serie Excel. */
export function parseImportDate(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;

  if (typeof raw === 'number') {
    if (raw > 1e12) return new Date(raw).toISOString();
    if (raw > 1e9) return new Date(raw * 1000).toISOString();
    if (raw > 20000 && raw < 80000) {
      const excelEpochMs = Date.UTC(1899, 11, 30);
      return new Date(excelEpochMs + raw * 86400000).toISOString();
    }
    return null;
  }

  const date = new Date(String(raw).trim());
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Parse un fichier .json/.csv/.xlsx en lignes brutes + intitules de colonnes detectes. */
export async function parseSanctionImportFile(file: File): Promise<{ headers: string[]; rows: ParsedImportRow[] }> {
  const name = file.name.toLowerCase();

  if (name.endsWith('.json')) {
    const text = await file.text();
    const data = JSON.parse(text);
    const list: unknown[] = Array.isArray(data)
      ? data
      : Array.isArray((data as Record<string, unknown>)?.sanctions)
        ? (data as Record<string, unknown>).sanctions as unknown[]
        : Array.isArray((data as Record<string, unknown>)?.cases)
          ? (data as Record<string, unknown>).cases as unknown[]
          : [];

    const rows = list.filter((r): r is ParsedImportRow => !!r && typeof r === 'object') as ParsedImportRow[];
    const headerSet = new Set<string>();
    for (const row of rows) {
      for (const key of Object.keys(row)) headerSet.add(key);
    }
    return { headers: Array.from(headerSet), rows };
  }

  const XLSX = await import('xlsx');
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { headers: [], rows: [] };

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<ParsedImportRow>(sheet, { defval: '' });
  const headers = rows.length > 0
    ? Object.keys(rows[0])
    : ((XLSX.utils.sheet_to_json(sheet, { header: 1 })[0] as string[] | undefined) ?? []);

  return { headers, rows };
}

/** Applique un mapping de colonnes a une ligne brute et valide/normalise chaque champ. */
export function normalizeImportRow(row: ParsedImportRow, mapping: ColumnMapping): NormalizedImportRow {
  const get = (field: SanctionImportField): unknown => {
    const header = mapping[field];
    return header ? row[header] : undefined;
  };

  const errors: string[] = [];

  const type = normalizeSanctionType(get('type'));
  if (!type) errors.push(m.ipx_type());

  const targetUserId = extractSnowflake(get('targetUserId'));
  if (!targetUserId) errors.push(m.ipx_target());

  const targetTagRaw = get('targetTag');
  const targetTag = targetTagRaw ? String(targetTagRaw).trim() : null;

  const moderatorUserId = extractSnowflake(get('moderatorUserId'));

  const moderatorTagRaw = get('moderatorTag');
  const moderatorTag = moderatorTagRaw ? String(moderatorTagRaw).trim() : null;

  const reasonRaw = get('reason');
  const reason = reasonRaw ? String(reasonRaw).trim() : '';

  const createdAt = parseImportDate(get('createdAt'));
  if (!createdAt) errors.push(m.ipx_date());

  const durationSeconds = parseDurationToSeconds(get('durationSeconds'));

  return { type, targetUserId, targetTag, moderatorUserId, moderatorTag, reason, createdAt, durationSeconds, errors };
}
