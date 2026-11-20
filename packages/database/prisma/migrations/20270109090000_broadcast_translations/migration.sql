-- Variantes de langue des annonces globales (texte de base en français).
ALTER TABLE "broadcast_logs" ADD COLUMN IF NOT EXISTS "translations" JSONB;
ALTER TABLE "broadcast_templates" ADD COLUMN IF NOT EXISTS "translations" JSONB;
