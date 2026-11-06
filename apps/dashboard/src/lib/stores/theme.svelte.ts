import { m } from '../i18n';
export type ThemeId =
  | 'light'
  | 'dark'
  | 'midnight'
  | 'nord'
  | 'sunset'
  | 'forest'
  | 'amoled'
  | 'lavender'
  | 'ocean'
  | 'custom';

export type ThemeMode = 'light' | 'dark';

export interface ThemePreset {
  id: ThemeId;
  label: string;
  mode: ThemeMode;
  icon: string;
  preview: { bg: string; surface: string; text: string };
  vars?: Record<string, string>;
}

// Surface-only vars keys (no primary/secondary/tertiary - those come from accent)
const SURFACE_VAR_KEYS = [
  '--background', '--surface', '--on-background', '--on-surface',
  '--surface-container-lowest', '--surface-container-low', '--surface-container',
  '--surface-container-high', '--surface-container-highest', '--on-surface-variant',
  '--outline', '--outline-variant', '--surface-hover', '--surface-selection',
] as const;


export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'light',
    label: m.thx_light(),
    mode: 'light',
    icon: 'sun',
    preview: { bg: '#ffffff', surface: '#f3f4f6', text: '#111827' },
  },
  {
    id: 'dark',
    label: m.thx_dark(),
    mode: 'dark',
    icon: 'moon',
    preview: { bg: '#09090b', surface: '#1c1c1f', text: '#fafafa' },
  },
  {
    id: 'midnight',
    label: 'Midnight',
    mode: 'dark',
    icon: 'moon',
    preview: { bg: '#0b1120', surface: '#131c31', text: '#e2e8f0' },
    vars: {
      '--background': '#0b1120',
      '--surface': '#0b1120',
      '--on-background': '#e2e8f0',
      '--on-surface': '#e2e8f0',
      '--surface-container-lowest': '#0f1729',
      '--surface-container-low': '#0d1322',
      '--surface-container': '#131c31',
      '--surface-container-high': '#1e293b',
      '--surface-container-highest': '#334155',
      '--on-surface-variant': '#94a3b8',
      '--outline': '#64748b',
      '--outline-variant': '#1e293b',
      '--surface-hover': 'rgba(148, 163, 184, 0.06)',
      '--surface-selection': 'rgba(96, 165, 250, 0.1)',
    },
  },
  {
    id: 'nord',
    label: 'Nord',
    mode: 'dark',
    icon: 'moon',
    preview: { bg: '#2e3440', surface: '#3b4252', text: '#eceff4' },
    vars: {
      '--background': '#2e3440',
      '--surface': '#2e3440',
      '--on-background': '#eceff4',
      '--on-surface': '#eceff4',
      '--surface-container-lowest': '#2e3440',
      '--surface-container-low': '#2e3440',
      '--surface-container': '#3b4252',
      '--surface-container-high': '#434c5e',
      '--surface-container-highest': '#4c566a',
      '--on-surface-variant': '#d8dee9',
      '--outline': '#4c566a',
      '--outline-variant': '#3b4252',
      '--surface-hover': 'rgba(216, 222, 233, 0.05)',
      '--surface-selection': 'rgba(136, 192, 208, 0.1)',
    },
  },
  {
    id: 'sunset',
    label: 'Sunset',
    mode: 'dark',
    icon: 'sun',
    preview: { bg: '#1a1014', surface: '#261a1f', text: '#fde8d8' },
    vars: {
      '--background': '#1a1014',
      '--surface': '#1a1014',
      '--on-background': '#fde8d8',
      '--on-surface': '#fde8d8',
      '--surface-container-lowest': '#1f141a',
      '--surface-container-low': '#1c1117',
      '--surface-container': '#261a1f',
      '--surface-container-high': '#362428',
      '--surface-container-highest': '#4a3035',
      '--on-surface-variant': '#c4a0a8',
      '--outline': '#8b6b72',
      '--outline-variant': '#362428',
      '--surface-hover': 'rgba(253, 186, 116, 0.06)',
      '--surface-selection': 'rgba(251, 146, 60, 0.1)',
    },
  },
  {
    id: 'forest',
    label: m.thx_forest(),
    mode: 'dark',
    icon: 'moon',
    preview: { bg: '#0c1a14', surface: '#14261c', text: '#d1fae5' },
    vars: {
      '--background': '#0c1a14',
      '--surface': '#0c1a14',
      '--on-background': '#d1fae5',
      '--on-surface': '#d1fae5',
      '--surface-container-lowest': '#0f1f18',
      '--surface-container-low': '#0e1c16',
      '--surface-container': '#14261c',
      '--surface-container-high': '#1c3327',
      '--surface-container-highest': '#2d4a3a',
      '--on-surface-variant': '#86c4a5',
      '--outline': '#4a7a64',
      '--outline-variant': '#1c3327',
      '--surface-hover': 'rgba(52, 211, 153, 0.06)',
      '--surface-selection': 'rgba(52, 211, 153, 0.1)',
    },
  },
  {
    id: 'amoled',
    label: 'AMOLED',
    mode: 'dark',
    icon: 'moon',
    preview: { bg: '#000000', surface: '#0a0a0a', text: '#ffffff' },
    vars: {
      '--background': '#000000',
      '--surface': '#000000',
      '--on-background': '#ffffff',
      '--on-surface': '#ffffff',
      '--surface-container-lowest': '#0a0a0a',
      '--surface-container-low': '#050505',
      '--surface-container': '#111111',
      '--surface-container-high': '#1a1a1a',
      '--surface-container-highest': '#2a2a2a',
      '--on-surface-variant': '#a3a3a3',
      '--outline': '#525252',
      '--outline-variant': '#1a1a1a',
      '--surface-hover': 'rgba(255, 255, 255, 0.04)',
      '--surface-selection': 'rgba(129, 140, 248, 0.08)',
    },
  },
  {
    id: 'lavender',
    label: m.thx_lavender(),
    mode: 'light',
    icon: 'sun',
    preview: { bg: '#faf5ff', surface: '#f3e8ff', text: '#3b0764' },
    vars: {
      '--background': '#faf5ff',
      '--surface': '#faf5ff',
      '--on-background': '#1e1b2e',
      '--on-surface': '#1e1b2e',
      '--surface-container-lowest': '#ffffff',
      '--surface-container-low': '#f5f0ff',
      '--surface-container': '#ede5ff',
      '--surface-container-high': '#ddd4f0',
      '--surface-container-highest': '#cdc4e0',
      '--on-surface-variant': '#6b5f80',
      '--outline': '#8e82a3',
      '--outline-variant': '#ddd4f0',
      '--surface-hover': 'rgba(124, 58, 237, 0.04)',
      '--surface-selection': 'rgba(124, 58, 237, 0.08)',
    },
  },
  {
    id: 'ocean',
    label: m.thx_ocean(),
    mode: 'light',
    icon: 'sun',
    preview: { bg: '#f0f9ff', surface: '#e0f2fe', text: '#0c4a6e' },
    vars: {
      '--background': '#f0f9ff',
      '--surface': '#f0f9ff',
      '--on-background': '#0c4a6e',
      '--on-surface': '#0c4a6e',
      '--surface-container-lowest': '#ffffff',
      '--surface-container-low': '#ecfeff',
      '--surface-container': '#e0f2fe',
      '--surface-container-high': '#bae6fd',
      '--surface-container-highest': '#7dd3fc',
      '--on-surface-variant': '#475569',
      '--outline': '#64748b',
      '--outline-variant': '#bae6fd',
      '--surface-hover': 'rgba(2, 132, 199, 0.04)',
      '--surface-selection': 'rgba(2, 132, 199, 0.08)',
    },
  },
];

// ─── Accent color system ────────────────────────────────────────────

export type AccentColorId = 'violet' | 'blue' | 'green' | 'rose' | 'orange' | 'cyan';

interface AccentVars {
  '--primary-color': string;
  '--on-primary-color': string;
  '--primary-container-color': string;
  '--on-primary-container-color': string;
  '--secondary-color': string;
  '--secondary-container-color': string;
  '--on-secondary-container-color': string;
  '--tertiary-color': string;
  '--tertiary-container-color': string;
  '--on-tertiary-container-color': string;
}

export const ACCENT_COLORS: Record<AccentColorId, { hex: string; light: AccentVars; dark: AccentVars }> = {
  violet: {
    hex: '#8b5cf6',
    light: {
      '--primary-color': '#7c3aed',
      '--on-primary-color': '#ffffff',
      '--primary-container-color': '#ede9fe',
      '--on-primary-container-color': '#4c1d95',
      '--secondary-color': '#8b5cf6',
      '--secondary-container-color': '#ddd6fe',
      '--on-secondary-container-color': '#5b21b6',
      '--tertiary-color': '#a78bfa',
      '--tertiary-container-color': '#ede9fe',
      '--on-tertiary-container-color': '#6d28d9',
    },
    dark: {
      '--primary-color': '#a78bfa',
      '--on-primary-color': '#2e1065',
      '--primary-container-color': '#3b0f8a',
      '--on-primary-container-color': '#ddd6fe',
      '--secondary-color': '#c4b5fd',
      '--secondary-container-color': '#4c1d95',
      '--on-secondary-container-color': '#ede9fe',
      '--tertiary-color': '#c084fc',
      '--tertiary-container-color': '#581c87',
      '--on-tertiary-container-color': '#f3e8ff',
    },
  },
  blue: {
    hex: '#3b82f6',
    light: {
      '--primary-color': '#2563eb',
      '--on-primary-color': '#ffffff',
      '--primary-container-color': '#dbeafe',
      '--on-primary-container-color': '#1e3a5f',
      '--secondary-color': '#3b82f6',
      '--secondary-container-color': '#bfdbfe',
      '--on-secondary-container-color': '#1e40af',
      '--tertiary-color': '#60a5fa',
      '--tertiary-container-color': '#dbeafe',
      '--on-tertiary-container-color': '#1d4ed8',
    },
    dark: {
      '--primary-color': '#60a5fa',
      '--on-primary-color': '#1e3a5f',
      '--primary-container-color': '#1e3a8a',
      '--on-primary-container-color': '#bfdbfe',
      '--secondary-color': '#93c5fd',
      '--secondary-container-color': '#1e40af',
      '--on-secondary-container-color': '#dbeafe',
      '--tertiary-color': '#7dd3fc',
      '--tertiary-container-color': '#0c4a6e',
      '--on-tertiary-container-color': '#e0f2fe',
    },
  },
  green: {
    hex: '#10b981',
    light: {
      '--primary-color': '#059669',
      '--on-primary-color': '#ffffff',
      '--primary-container-color': '#d1fae5',
      '--on-primary-container-color': '#064e3b',
      '--secondary-color': '#10b981',
      '--secondary-container-color': '#a7f3d0',
      '--on-secondary-container-color': '#065f46',
      '--tertiary-color': '#34d399',
      '--tertiary-container-color': '#d1fae5',
      '--on-tertiary-container-color': '#047857',
    },
    dark: {
      '--primary-color': '#34d399',
      '--on-primary-color': '#064e3b',
      '--primary-container-color': '#065f46',
      '--on-primary-container-color': '#a7f3d0',
      '--secondary-color': '#6ee7b7',
      '--secondary-container-color': '#047857',
      '--on-secondary-container-color': '#d1fae5',
      '--tertiary-color': '#5eead4',
      '--tertiary-container-color': '#134e4a',
      '--on-tertiary-container-color': '#ccfbf1',
    },
  },
  rose: {
    hex: '#f43f5e',
    light: {
      '--primary-color': '#e11d48',
      '--on-primary-color': '#ffffff',
      '--primary-container-color': '#ffe4e6',
      '--on-primary-container-color': '#881337',
      '--secondary-color': '#f43f5e',
      '--secondary-container-color': '#fecdd3',
      '--on-secondary-container-color': '#9f1239',
      '--tertiary-color': '#fb7185',
      '--tertiary-container-color': '#ffe4e6',
      '--on-tertiary-container-color': '#be123c',
    },
    dark: {
      '--primary-color': '#fb7185',
      '--on-primary-color': '#881337',
      '--primary-container-color': '#9f1239',
      '--on-primary-container-color': '#fecdd3',
      '--secondary-color': '#fda4af',
      '--secondary-container-color': '#be123c',
      '--on-secondary-container-color': '#ffe4e6',
      '--tertiary-color': '#f9a8d4',
      '--tertiary-container-color': '#831843',
      '--on-tertiary-container-color': '#fce7f3',
    },
  },
  orange: {
    hex: '#f97316',
    light: {
      '--primary-color': '#ea580c',
      '--on-primary-color': '#ffffff',
      '--primary-container-color': '#ffedd5',
      '--on-primary-container-color': '#7c2d12',
      '--secondary-color': '#f97316',
      '--secondary-container-color': '#fed7aa',
      '--on-secondary-container-color': '#9a3412',
      '--tertiary-color': '#fb923c',
      '--tertiary-container-color': '#ffedd5',
      '--on-tertiary-container-color': '#c2410c',
    },
    dark: {
      '--primary-color': '#fb923c',
      '--on-primary-color': '#431407',
      '--primary-container-color': '#7c2d12',
      '--on-primary-container-color': '#fed7aa',
      '--secondary-color': '#fdba74',
      '--secondary-container-color': '#9a3412',
      '--on-secondary-container-color': '#ffedd5',
      '--tertiary-color': '#fbbf24',
      '--tertiary-container-color': '#713f12',
      '--on-tertiary-container-color': '#fef3c7',
    },
  },
  cyan: {
    hex: '#06b6d4',
    light: {
      '--primary-color': '#0891b2',
      '--on-primary-color': '#ffffff',
      '--primary-container-color': '#cffafe',
      '--on-primary-container-color': '#164e63',
      '--secondary-color': '#06b6d4',
      '--secondary-container-color': '#a5f3fc',
      '--on-secondary-container-color': '#155e75',
      '--tertiary-color': '#22d3ee',
      '--tertiary-container-color': '#cffafe',
      '--on-tertiary-container-color': '#0e7490',
    },
    dark: {
      '--primary-color': '#22d3ee',
      '--on-primary-color': '#164e63',
      '--primary-container-color': '#155e75',
      '--on-primary-container-color': '#a5f3fc',
      '--secondary-color': '#67e8f9',
      '--secondary-container-color': '#0e7490',
      '--on-secondary-container-color': '#cffafe',
      '--tertiary-color': '#5eead4',
      '--tertiary-container-color': '#134e4a',
      '--on-tertiary-container-color': '#ccfbf1',
    },
  },
};

// ─── Custom theme ───────────────────────────────────────────────────

export interface CustomThemeColors {
  background: string;
  surface: string;
  text: string;
  surfaceContainer: string;
  mode: ThemeMode;
}

const DEFAULT_CUSTOM_COLORS: CustomThemeColors = {
  background: '#09090b',
  surface: '#1c1c1f',
  text: '#fafafa',
  surfaceContainer: '#27272a',
  mode: 'dark',
};

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return null;
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function lighten(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const r = Math.min(255, Math.round(rgb.r + (255 - rgb.r) * amount));
  const g = Math.min(255, Math.round(rgb.g + (255 - rgb.g) * amount));
  const b = Math.min(255, Math.round(rgb.b + (255 - rgb.b) * amount));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function darken(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const r = Math.max(0, Math.round(rgb.r * (1 - amount)));
  const g = Math.max(0, Math.round(rgb.g * (1 - amount)));
  const b = Math.max(0, Math.round(rgb.b * (1 - amount)));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

export function buildCustomSurfaceVars(colors: CustomThemeColors): Record<string, string> {
  const isDark = colors.mode === 'dark';
  const mix = isDark ? lighten : darken;
  const textSecondary = isDark ? darken(colors.text, 0.35) : lighten(colors.text, 0.35);
  const outline = isDark ? lighten(colors.background, 0.25) : darken(colors.background, 0.25);

  return {
    '--background': colors.background,
    '--surface': colors.background,
    '--on-background': colors.text,
    '--on-surface': colors.text,
    '--surface-container-lowest': isDark ? lighten(colors.background, 0.04) : '#ffffff',
    '--surface-container-low': isDark ? lighten(colors.background, 0.02) : darken(colors.background, 0.02),
    '--surface-container': colors.surfaceContainer,
    '--surface-container-high': mix(colors.surfaceContainer, 0.15),
    '--surface-container-highest': mix(colors.surfaceContainer, 0.35),
    '--on-surface-variant': textSecondary,
    '--outline': outline,
    '--outline-variant': isDark ? lighten(colors.background, 0.1) : darken(colors.background, 0.1),
    '--surface-hover': isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
    '--surface-selection': isDark ? 'rgba(129,140,248,0.08)' : 'rgba(99,102,241,0.06)',
  };
}

// ─── Store ──────────────────────────────────────────────────────────

const THEME_KEY = 'kotbo_theme';
const CUSTOM_COLORS_KEY = 'kotbo_custom_theme';
/**
 * Dernier thème retenu pour chaque mode. Le bouton clair/sombre y revient au
 * lieu de retomber sur les presets nus : sans ça, basculer depuis Midnight
 * effaçait le choix de l'utilisateur, qui devait le refaire à chaque aller-retour.
 */
const PREFERRED_KEY = 'kotbo_theme_preferred';

function createThemeStore() {
  const savedId = (typeof localStorage !== 'undefined' ? localStorage.getItem(THEME_KEY) : null) as ThemeId | null;

  const initialThemeId: ThemeId =
    savedId && (THEME_PRESETS.some(p => p.id === savedId) || savedId === 'custom') ? savedId : 'dark';

  let themeId = $state<ThemeId>(initialThemeId);
  let customColors = $state<CustomThemeColors>(loadCustomColors());
  let currentAccent = $state<AccentColorId>('violet');
  let preferredByMode = $state<Record<ThemeMode, ThemeId>>(loadPreferred());

  function loadPreferred(): Record<ThemeMode, ThemeId> {
    const fallback: Record<ThemeMode, ThemeId> = { light: 'light', dark: 'dark' };
    try {
      if (typeof localStorage === 'undefined') return fallback;
      const raw = localStorage.getItem(PREFERRED_KEY);
      if (raw) return { ...fallback, ...JSON.parse(raw) };
    } catch { /* ignore */ }
    return fallback;
  }

  function modeOf(id: ThemeId): ThemeMode {
    if (id === 'custom') return customColors.mode;
    return THEME_PRESETS.find(p => p.id === id)?.mode ?? 'dark';
  }

  /** Retient un thème comme choix de l'utilisateur pour le mode auquel il appartient. */
  function rememberPreferred(id: ThemeId) {
    const next: Record<ThemeMode, ThemeId> = { ...preferredByMode };
    next[modeOf(id)] = id;
    preferredByMode = next;
    try {
      localStorage.setItem(PREFERRED_KEY, JSON.stringify(preferredByMode));
    } catch { /* ignore */ }
  }

  function themeForMode(mode: ThemeMode): ThemeId {
    const candidate = preferredByMode[mode];
    // Le thème « custom » peut avoir changé de mode depuis qu'il a été retenu :
    // on ne le ressort que s'il correspond toujours au mode demandé.
    if (candidate && modeOf(candidate) === mode) return candidate;
    return mode === 'dark' ? 'dark' : 'light';
  }

  function applyThemeId(id: ThemeId) {
    themeId = id;
    rememberPreferred(id);
    try {
      localStorage.setItem(THEME_KEY, id);
    } catch { /* ignore */ }
    applyAll();
    syncThemeToDb(id, customColors);
  }

  function loadCustomColors(): CustomThemeColors {
    try {
      if (typeof localStorage === 'undefined') return { ...DEFAULT_CUSTOM_COLORS };
      const raw = localStorage.getItem(CUSTOM_COLORS_KEY);
      if (raw) return { ...DEFAULT_CUSTOM_COLORS, ...JSON.parse(raw) };
    } catch { /* ignore */ }
    return { ...DEFAULT_CUSTOM_COLORS };
  }

  function getMode(): ThemeMode {
    return modeOf(themeId);
  }


  function applySurfaceVars() {
    if (typeof document === 'undefined') return;

    const mode = getMode();
    document.documentElement.classList.toggle('dark', mode === 'dark');
    document.documentElement.dataset.theme = themeId;

    const preset = THEME_PRESETS.find(p => p.id === themeId);
    const vars = themeId === 'custom'
      ? buildCustomSurfaceVars(customColors)
      : preset?.vars;

    // Clear previous surface vars first
    for (const key of SURFACE_VAR_KEYS) {
      document.documentElement.style.removeProperty(key);
    }

    if (vars) {
      for (const [key, value] of Object.entries(vars)) {
        document.documentElement.style.setProperty(key, value);
      }
    }
  }

  function applyAccentVars() {
    if (typeof document === 'undefined') return;
    const mode = getMode();
    const accent = ACCENT_COLORS[currentAccent];
    if (!accent) return;

    const vars = mode === 'dark' ? accent.dark : accent.light;
    for (const [key, value] of Object.entries(vars)) {
      document.documentElement.style.setProperty(key, value);
    }
  }

  function applyAll() {
    applySurfaceVars();
    applyAccentVars();
  }

  async function syncThemeToDb(id: ThemeId, colors: CustomThemeColors) {
    try {
      const { authStore } = await import('./auth.svelte');
      if (!authStore.selectedGuildId || !authStore.token) return;
      const { updateUserSettings } = await import('../api');
      await updateUserSettings({
        themeId: id,
        customTheme: id === 'custom' ? colors : null
      });
    } catch (e) {
      // ignore
    }
  }

  async function syncAccentToDb(accent: AccentColorId) {
    try {
      const { authStore } = await import('./auth.svelte');
      if (!authStore.selectedGuildId || !authStore.token) return;
      const { updateUserSettings } = await import('../api');
      await updateUserSettings({
        accentColor: accent
      });
    } catch (e) {
      // ignore
    }
  }

  rememberPreferred(initialThemeId);
  applyAll();

  return {
    get dark() {
      return getMode() === 'dark';
    },

    set dark(value: boolean) {
      applyThemeId(themeForMode(value ? 'dark' : 'light'));
    },

    get themeId() {
      return themeId;
    },

    set themeId(id: ThemeId) {
      applyThemeId(id);
    },

    get mode(): ThemeMode {
      return getMode();
    },

    get customColors() {
      return customColors;
    },

    setCustomColors(colors: CustomThemeColors) {
      customColors = { ...colors };
      localStorage.setItem(CUSTOM_COLORS_KEY, JSON.stringify(customColors));
      // Le mode du thème custom vient de changer : il doit être retenu pour le
      // bon mode, sinon la bascule le proposerait encore pour l'ancien.
      if (themeId === 'custom') { rememberPreferred('custom'); applyAll(); }
      syncThemeToDb(themeId, customColors);
    },

    setAccent(accent: AccentColorId) {
      currentAccent = accent;
      applyAccentVars();
      syncAccentToDb(accent);
    },

    toggle() {
      applyThemeId(themeForMode(getMode() === 'dark' ? 'light' : 'dark'));
    },
  };
}

export const themeStore = createThemeStore();
