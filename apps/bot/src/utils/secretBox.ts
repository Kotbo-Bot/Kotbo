import crypto from 'node:crypto';

/**
 * Chiffrement au repos des secrets que les serveurs nous confient (jeton et
 * secret OAuth d'un Custom Bot).
 *
 * La clé vient de `CUSTOM_BOT_ENCRYPTION_KEY`, à défaut de `JWT_SECRET`. Aucun
 * repli aléatoire : `instanceResolver` en tire un au démarrage quand
 * `JWT_SECRET` manque, et un secret chiffré avec lui deviendrait illisible au
 * redémarrage suivant. Sans clé, on refuse d'enregistrer plutôt que de stocker
 * en clair ou de perdre la donnée.
 *
 * Changer la clé rend les secrets déjà stockés illisibles : il faudra les
 * ressaisir.
 */

const PREFIX = 'enc:v1:';

const DEFAULT_ENV = ['CUSTOM_BOT_ENCRYPTION_KEY', 'JWT_SECRET'];

export class SecretBoxUnavailableError extends Error {
  constructor(envNames: readonly string[] = DEFAULT_ENV) {
    super(`Chiffrement indisponible : définir ${envNames.join(' ou ')}.`);
    this.name = 'SecretBoxUnavailableError';
  }
}

export function isSealed(value: string): boolean {
  return value.startsWith(PREFIX);
}

export interface SecretBox {
  /** `context` lie le chiffré à un contexte (un serveur) : ailleurs, il ne s'ouvre pas. */
  seal(plain: string, context?: string): string;
  /** Valeur sans préfixe rendue telle quelle ; `null` si illisible (clé changée, donnée altérée, autre contexte). */
  open(stored: string, context?: string): string | null;
}

/**
 * Coffre AES-256-GCM dont la clé dérive de la première variable
 * d'environnement définie parmi `envNames`, séparée des autres coffres par
 * `label`.
 */
export function createSecretBox(label: string, envNames: readonly string[]): SecretBox {
  function key(): Buffer {
    const secret = envNames.map((name) => process.env[name]).find(Boolean);
    if (!secret) throw new SecretBoxUnavailableError(envNames);
    return crypto.createHash('sha256').update(`${label}:${secret}`).digest();
  }

  return {
    seal(plain, context) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
      if (context) cipher.setAAD(Buffer.from(context, 'utf8'));
      const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return `${PREFIX}${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
    },
    open(stored, context) {
      if (!isSealed(stored)) return stored;
      const [iv, tag, data] = stored.slice(PREFIX.length).split('.');
      if (!iv || !tag || !data) return null;
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
        if (context) decipher.setAAD(Buffer.from(context, 'utf8'));
        decipher.setAuthTag(Buffer.from(tag, 'base64url'));
        return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
      } catch (error) {
        if (error instanceof SecretBoxUnavailableError) throw error;
        return null;
      }
    },
  };
}

const secretBox = createSecretBox('kotbo-secret-box', DEFAULT_ENV);

export function sealSecret(plain: string): string {
  return secretBox.seal(plain);
}

/**
 * Déchiffre une valeur stockée. Une valeur sans préfixe est un secret enregistré
 * en clair avant le chiffrement : elle est rendue telle quelle, et sera chiffrée
 * au prochain enregistrement. Retourne `null` si la valeur est illisible (clé
 * changée, donnée altérée).
 */
export function openSecret(stored: string): string | null {
  return secretBox.open(stored);
}
