-- Drops : une reprise de versement en échec n'est plus retentée sans fin. Les reprises
-- sont comptées, et le ramassage est abandonné passé le plafond fixé dans `@kotbo/shared`.

ALTER TABLE "drop_claims" ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "drop_claims" ADD COLUMN IF NOT EXISTS "abandonedAt" TIMESTAMP(3);

-- La reprise ne lit plus que les ramassages ni versés ni abandonnés.
DROP INDEX IF EXISTS "drop_claims_paidAt_attemptedAt_idx";
CREATE INDEX IF NOT EXISTS "drop_claims_paidAt_abandonedAt_attemptedAt_idx" ON "drop_claims"("paidAt", "abandonedAt", "attemptedAt");
