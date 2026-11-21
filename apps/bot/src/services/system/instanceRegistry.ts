import crypto from 'node:crypto';

/**
 * Bail d'appartenance au registre des instances self-host.
 *
 * Le master signe (Ed25519) un bail `{ botClientId, machineFingerprint, exp }`
 * pour chaque instance qu'il a autorisée ; l'instance le présente à chaque
 * démarrage. Sans bail valide, elle ne tourne pas : c'est ce qui fait passer le
 * ping d'un voyant qu'on peut taire à une condition de fonctionnement. Un faux
 * serveur maître ne peut pas répondre à sa place, faute de la clé privée.
 *
 * Limite assumée : le code est ouvert, quelqu'un qui retire ces vérifications de
 * sa copie les retire. Le verrou qui tient sans condition, c'est la licence du dépôt ; ce module ne fait que rendre l'usage non autorisé volontaire et net.
 */

/** Clé publique de vérification (SPKI DER, base64). La privée n'est jamais dans le dépôt. */
const REGISTRY_PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEApsPuktu31vgOUA7QVMpit0Embf5LAc00I4aeAaNb8Go=';

/** Durée de validité d'un bail : laisse une panne du master de 3 jours sans conséquence. */
export const LEASE_TTL_MS = 72 * 60 * 60 * 1000;

export interface LeasePayload {
  botClientId: string;
  machineFingerprint: string | null;
  /** Échéance, en millisecondes epoch. */
  exp: number;
}

const publicKey = crypto.createPublicKey({
  key: Buffer.from(REGISTRY_PUBLIC_KEY_B64, 'base64'),
  format: 'der',
  type: 'spki',
});

const b64url = (buf: Buffer) => buf.toString('base64url');

let issuerKey: crypto.KeyObject | null | undefined;

/**
 * Clé privée d'émission, si ce process la détient pour de bon.
 *
 * Une variable d'environnement non vide ne suffit pas : n'importe quel
 * self-hoster pourrait y mettre n'importe quoi pour passer pour le master. On
 * exige donc que la clé fournie corresponde à la clé publique embarquée, ce que
 * seul le détenteur de la vraie clé privée peut satisfaire.
 */
function getIssuerKey(): crypto.KeyObject | null {
  if (issuerKey !== undefined) return issuerKey;
  issuerKey = null;
  const raw = process.env.KOTBO_REGISTRY_PRIVATE_KEY?.trim();
  if (!raw) return issuerKey;
  try {
    const priv = crypto.createPrivateKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'pkcs8' });
    const derived = crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' });
    const embedded = publicKey.export({ type: 'spki', format: 'der' });
    if (Buffer.compare(derived, embedded) === 0) issuerKey = priv;
  } catch {
    // Clé illisible : traitée comme absente.
  }
  return issuerKey;
}

/** Vrai pour le process du master (détenteur de la clé privée) : il n'a pas à s'inscrire lui-même au registre. */
export function isRegistryIssuer(): boolean {
  return getIssuerKey() !== null;
}

/** Émet un bail signé. Ne s'utilise que sur le master. */
export function signLease(botClientId: string, machineFingerprint: string | null, now = Date.now()): string {
  const key = getIssuerKey();
  if (!key) throw new Error("Clé privée d'émission absente ou invalide (KOTBO_REGISTRY_PRIVATE_KEY).");
  const payload: LeasePayload = { botClientId, machineFingerprint, exp: now + LEASE_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload));
  return `${b64url(body)}.${b64url(crypto.sign(null, body, key))}`;
}

/**
 * Vérifie un bail : signature, instance visée, empreinte et échéance.
 * L'empreinte n'est comparée que si le bail en porte une, pour ne pas
 * invalider une instance dont la base vient d'être réinitialisée avant son
 * prochain ping (elle en recevra un neuf).
 */
export function verifyLease(
  token: string | null | undefined,
  botClientId: string,
  machineFingerprint: string | null,
  now = Date.now(),
): boolean {
  if (!token) return false;
  const [bodyPart, sigPart, ...rest] = token.split('.');
  if (!bodyPart || !sigPart || rest.length > 0) return false;
  try {
    const body = Buffer.from(bodyPart, 'base64url');
    if (!crypto.verify(null, body, publicKey, Buffer.from(sigPart, 'base64url'))) return false;
    const payload = JSON.parse(body.toString('utf8')) as Partial<LeasePayload>;
    if (payload.botClientId !== botClientId) return false;
    if (typeof payload.exp !== 'number' || payload.exp <= now) return false;
    if (payload.machineFingerprint && machineFingerprint && payload.machineFingerprint !== machineFingerprint) return false;
    return true;
  } catch {
    return false;
  }
}

/** Le master n'applique la liste blanche que si on le lui demande, pour déployer sans casser les instances légitimes. */
export function isInstanceAuthEnforced(): boolean {
  return process.env.KOTBO_REQUIRE_INSTANCE_AUTH === 'true';
}
