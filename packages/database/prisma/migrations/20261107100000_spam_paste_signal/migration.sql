-- Anti-spam : signal « copier-coller » (gros message après une frappe trop courte).
ALTER TABLE "spam_detection_configs" ADD COLUMN IF NOT EXISTS "pasteSignalEnabled" BOOLEAN NOT NULL DEFAULT true;
