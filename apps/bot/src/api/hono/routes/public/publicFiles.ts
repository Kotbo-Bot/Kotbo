/**
 * Fichiers servis par lien signé : transcription de ticket (HTML) et pièces
 * jointes de preuve d'une sanction. La signature HMAC et l'expiration tiennent
 * lieu d'authentification.
 */
import { Hono, type Context } from 'hono';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { stripLegacyAvatarBackground } from '../../../../services/features/transcriptService.js';
import { getDashboardOrigin } from '../../../shared.js';
import { send } from './kit.js';

const gzipAsync = promisify(gzip);
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

/** Le contenu servi s'affiche dans une iframe du dashboard : on ouvre `frame-ancestors` à lui seul. */
function allowDashboardFraming(c: Context): void {
  c.header('X-Frame-Options', undefined);
  c.header(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      'img-src https: data:',
      'media-src https:',
      `frame-ancestors ${getDashboardOrigin()} http://localhost:5173 http://localhost:3000`,
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; '),
  );
}

export function createPublicFilesRouter(): Hono {
  const router = new Hono();

  router.get('/api/public/transcripts/:transcriptId', async (c) => {
    const transcriptId = c.req.param('transcriptId');
    if (!SAFE_ID.test(transcriptId)) return send(c, { error: 'ID de transcription invalide' }, 400);

    // Vérifier la signature HMAC et l'expiration
    const sig = c.req.query('sig');
    const expires = c.req.query('expires');
    if (!sig || !expires) {
      return send(c, { error: 'Lien invalide - signature manquante. Demandez un nouveau lien depuis le dashboard.' }, 403);
    }
    const { verifyTranscriptSignature } = await import('@kotbo/core');
    if (!verifyTranscriptSignature(transcriptId, expires, sig)) {
      return send(c, { error: 'Lien invalide ou expiré. Demandez un nouveau lien depuis le dashboard.' }, 403);
    }

    const maxAge = Math.max(0, Math.min(3600, parseInt(expires, 10) - Math.floor(Date.now() / 1000)));

    try {
      const meta = await prisma.transcript.findUnique({ where: { id: transcriptId }, select: { format: true } });
      if (!meta) return send(c, { error: 'Transcription introuvable' }, 404);

      // Suffixe à changer quand le contenu servi change (HTML : fond des avatars, v2 ; JSON : version du format).
      const isJson = meta.format === 'json';
      const etag = isJson ? `"transcript-${transcriptId}-json-v1"` : `"transcript-${transcriptId}-v2"`;
      if (c.req.header('if-none-match') === etag) {
        return c.body(null, 304, { ETag: etag, 'Cache-Control': `private, max-age=${maxAge}` });
      }

      const transcript = await prisma.transcript.findUnique({ where: { id: transcriptId }, select: { html: true, data: true } });
      if (!transcript) return send(c, { error: 'Transcription introuvable' }, 404);

      let body: string;
      if (isJson) {
        // Lu par la page /transcripts du dashboard (fetch, CORS du dashboard), rendu par @arcscord/discord-ui.
        body = JSON.stringify(transcript.data);
        c.header('Content-Type', 'application/json; charset=utf-8');
      } else {
        if (!transcript.html) return send(c, { error: 'Transcription introuvable' }, 404);
        body = stripLegacyAvatarBackground(transcript.html);
        allowDashboardFraming(c);
        c.header('Content-Type', 'text/html; charset=utf-8');
      }
      c.header('Cache-Control', `private, max-age=${maxAge}`);
      c.header('ETag', etag);

      // Plusieurs Mo possibles : compression asynchrone ici pour ne pas
      // bloquer l'event loop.
      if (/\bgzip\b/.test(c.req.header('accept-encoding') ?? '')) {
        const compressed = await gzipAsync(Buffer.from(body));
        c.header('Content-Encoding', 'gzip');
        c.header('Vary', 'Accept-Encoding');
        return c.body(new Uint8Array(compressed), 200);
      }
      return c.body(body, 200);
    } catch (err: unknown) {
      logger.error('PublicAPI', `Error fetching public transcript ${transcriptId}: ${err instanceof Error ? err.message : String(err)}`);
      return send(c, { error: 'Erreur interne du serveur' }, 500);
    }
  });

  router.get('/api/public/sanction-evidence/:fileId', async (c) => {
    const fileId = c.req.param('fileId');
    if (!SAFE_ID.test(fileId)) return send(c, { error: 'ID de fichier invalide' }, 400);

    const sig = c.req.query('sig');
    const expires = c.req.query('expires');
    if (!sig || !expires) return send(c, { error: 'Lien invalide - signature ou expiration manquante.' }, 403);

    const { verifyEvidenceFileSignature } = await import('@kotbo/core');
    if (!verifyEvidenceFileSignature(fileId, expires, sig)) {
      return send(c, { error: 'Lien de preuve invalide ou expiré.' }, 403);
    }

    try {
      const file = await prisma.sanctionEvidenceFile.findUnique({ where: { id: fileId } });
      if (!file) return send(c, { error: 'Fichier de preuve introuvable.' }, 404);

      allowDashboardFraming(c);
      c.header('Content-Type', file.mimeType);
      const safeFilename = file.fileName.replace(/[^\x20-\x7E]/g, '_');
      c.header('Content-Disposition', `inline; filename="${safeFilename}"`);
      return c.body(new Uint8Array(file.data), 200);
    } catch (err: unknown) {
      logger.error('PublicAPI', `Error fetching public evidence file ${fileId}: ${err instanceof Error ? err.message : String(err)}`);
      return send(c, { error: 'Erreur interne du serveur' }, 500);
    }
  });

  return router;
}
