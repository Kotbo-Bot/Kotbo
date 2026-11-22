import crypto from 'node:crypto';

/**
 * Chiffrement au repos des identifiants mail BYOP (clés API AWS SES, Resend,
 * mots de passe SMTP/IMAP et secrets de webhook entrant).
 *
 * Utilise AES-256-GCM avec une clé dérivée de `MAIL_ENCRYPTION_KEY` (ou, à
 * défaut en développement, `CUSTOM_BOT_ENCRYPTION_KEY` / `JWT_SECRET`).
 * Aucun repli aléatoire : si aucune clé n'est définie, on refuse d'enregistrer
 * plutôt que de stocker des identifiants en clair ou de les rendre illisibles
 * au redémarrage suivant.
 */

const PREFIX = 'mail:v1:';

export class MailCryptoUnavailableError extends Error {
  constructor() {
    super('Chiffrement mail indisponible : définir MAIL_ENCRYPTION_KEY.');
    this.name = 'MailCryptoUnavailableError';
  }
}

function resolveKey(): Buffer {
  const secret =
    process.env.MAIL_ENCRYPTION_KEY ||
    process.env.CUSTOM_BOT_ENCRYPTION_KEY ||
    process.env.JWT_SECRET;
  if (!secret) throw new MailCryptoUnavailableError();
  return crypto.createHash('sha256').update(`kotbo-mail-box:${secret}`).digest();
}

export function isMailSecretSealed(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function sealMailSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', resolveKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${PREFIX}${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function openMailSecret(stored: string): string | null {
  if (!isMailSecretSealed(stored)) return null;

  const [iv, tag, data] = stored.slice(PREFIX.length).split('.');
  if (!iv || !tag || !data) return null;

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', resolveKey(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch (error) {
    if (error instanceof MailCryptoUnavailableError) throw error;
    return null;
  }
}

export function sealMailCredentials<T extends object>(credentials: T): string {
  return sealMailSecret(JSON.stringify(credentials));
}

export function openMailCredentials<T>(stored: string): T | null {
  const raw = openMailSecret(stored);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function generateMailWebhookSecret(): string {
  return `mwh_${crypto.randomBytes(24).toString('base64url')}`;
}

export function verifyTimingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
