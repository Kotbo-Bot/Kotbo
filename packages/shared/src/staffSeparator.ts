/** Styles des rôles « séparateur » posés entre les hiérarchies staff. */
export const STAFF_SEPARATOR_STYLES = {
  line: (n: string) => `──── ${n} ────`,
  heavy: (n: string) => `━━━ ${n} ━━━`,
  double: (n: string) => `══ ${n} ══`,
  brackets: (n: string) => `【 ${n} 】`,
  stars: (n: string) => `✦ ${n} ✦`,
  arrows: (n: string) => `» ${n} «`,
  rule: () => '────────────────',
} as const;

export type StaffSeparatorStyle = keyof typeof STAFF_SEPARATOR_STYLES;

export const STAFF_SEPARATOR_STYLE_KEYS = Object.keys(STAFF_SEPARATOR_STYLES) as StaffSeparatorStyle[];

export const isStaffSeparatorStyle = (value: unknown): value is StaffSeparatorStyle =>
  typeof value === 'string' && Object.hasOwn(STAFF_SEPARATOR_STYLES, value);

/** Nom Discord (100 caractères max) du séparateur d'une hiérarchie. */
export const staffSeparatorName = (style: StaffSeparatorStyle, hierarchyName: string): string =>
  STAFF_SEPARATOR_STYLES[style](hierarchyName.trim().toUpperCase().slice(0, 60));
