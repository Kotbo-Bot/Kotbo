/**
 * Briques HTML du rendu du site communautaire.
 *
 * Tout ce qui vient d'un utilisateur (contenu des pages, noms Discord, titres
 * de formulaires) passe par `esc` avant d'entrer dans une chaîne HTML, y
 * compris dans les attributs : `esc` couvre les guillemets simples et doubles.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function esc(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

/** Construit une liste d'attributs ; les valeurs fausses sont omises. */
export function attrs(values: Record<string, string | number | boolean | null | undefined>): string {
  const out: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    if (value === false || value === null || value === undefined || value === '') continue;
    out.push(value === true ? name : `${name}="${esc(value)}"`);
  }
  return out.length > 0 ? ` ${out.join(' ')}` : '';
}

/** Classe CSS composée à partir d'une liste ; les entrées vides sautent. */
export function cls(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ');
}

/** Texte tronqué proprement sur un mot, avec points de suspension. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Initiales d'un nom, pour l'avatar de repli. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}

/** Nonce CSP d'une réponse : 16 octets aléatoires en base64. */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64');
}
