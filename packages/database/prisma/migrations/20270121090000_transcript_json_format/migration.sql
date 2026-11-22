-- Transcriptions en JSON : les nouvelles stockent leurs messages au format de
-- l'API Discord dans "data", les anciennes gardent leur HTML ("format" = 'html').
-- Aucune donnée existante n'est réécrite.
ALTER TABLE "transcripts" ALTER COLUMN "html" DROP NOT NULL;
ALTER TABLE "transcripts" ADD COLUMN IF NOT EXISTS "data" JSONB;
ALTER TABLE "transcripts" ADD COLUMN IF NOT EXISTS "format" TEXT NOT NULL DEFAULT 'html';
ALTER TABLE "transcripts" ADD COLUMN IF NOT EXISTS "messageCount" INTEGER;
