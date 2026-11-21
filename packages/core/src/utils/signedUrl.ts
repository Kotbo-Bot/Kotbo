import crypto from 'node:crypto';

export function getSigningSecret(): string {
  const secret = process.env.TRANSCRIPT_SIGNING_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('TRANSCRIPT_SIGNING_SECRET ou JWT_SECRET requis pour les URLs signées');
  }
  return secret;
}

export function generateTranscriptSignature(
  transcriptId: string,
  expiresInSeconds = 3600,
): { expires: number; signature: string } {
  const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const payload = `${transcriptId}:${expires}`;
  const signature = crypto
    .createHmac('sha256', getSigningSecret())
    .update(payload)
    .digest('hex');
  return { expires, signature };
}

export function verifyTranscriptSignature(
  transcriptId: string,
  expires: string,
  signature: string,
): boolean {
  const expiresNum = parseInt(expires, 10);
  if (isNaN(expiresNum) || expiresNum < Math.floor(Date.now() / 1000)) {
    return false;
  }
  const payload = `${transcriptId}:${expiresNum}`;
  const expected = crypto
    .createHmac('sha256', getSigningSecret())
    .update(payload)
    .digest('hex');
  if (expected.length !== signature.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// Signatures pour les fichiers de preuve uploadés (sanction evidence).
// Le payload est préfixé par "evidence:" pour que ces signatures ne puissent
// pas être rejouées contre la route /transcripts (et inversement), même si
// deux IDs cuid venaient à coïncider entre les deux tables.
export function generateEvidenceFileSignature(
  fileId: string,
  expiresInSeconds = 3600,
): { expires: number; signature: string } {
  const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const payload = `evidence:${fileId}:${expires}`;
  const signature = crypto
    .createHmac('sha256', getSigningSecret())
    .update(payload)
    .digest('hex');
  return { expires, signature };
}

export function verifyEvidenceFileSignature(
  fileId: string,
  expires: string,
  signature: string,
): boolean {
  const expiresNum = parseInt(expires, 10);
  if (isNaN(expiresNum) || expiresNum < Math.floor(Date.now() / 1000)) {
    return false;
  }
  const payload = `evidence:${fileId}:${expiresNum}`;
  const expected = crypto
    .createHmac('sha256', getSigningSecret())
    .update(payload)
    .digest('hex');
  if (expected.length !== signature.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
