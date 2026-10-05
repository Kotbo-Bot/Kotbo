-- Kotbo × AegisAI : transcription de preuve rattachée à une détection.
ALTER TABLE "aegis_detections" ADD COLUMN IF NOT EXISTS "evidenceUrl" TEXT;
