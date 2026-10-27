-- AegisAI : portée de l'analyse (messages, fils, vocaux, membres exemptés).
ALTER TABLE "aegis_configs" ADD COLUMN IF NOT EXISTS "analyzeMessages" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "aegis_configs" ADD COLUMN IF NOT EXISTS "analyzeThreads" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "aegis_configs" ADD COLUMN IF NOT EXISTS "analyzeVoiceChats" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "aegis_configs" ADD COLUMN IF NOT EXISTS "analyzeExempt" BOOLEAN NOT NULL DEFAULT true;
