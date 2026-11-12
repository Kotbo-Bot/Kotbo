-- Drops : la réservation d'une place et le versement du gain sont suivis séparément,
-- pour que le cycle reprenne un versement interrompu.

ALTER TABLE "drop_claims" ADD COLUMN IF NOT EXISTS "paidAt" TIMESTAMP(3);
ALTER TABLE "drop_claims" ADD COLUMN IF NOT EXISTS "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Les ramassages existants sont tenus pour versés : rien ne permet de distinguer
-- après coup ceux qu'un incident aurait laissés en route, et les reprendre tous
-- verserait une seconde fois la quasi-totalité.
UPDATE "drop_claims" SET "paidAt" = "createdAt" WHERE "paidAt" IS NULL;

CREATE INDEX IF NOT EXISTS "drop_claims_paidAt_attemptedAt_idx" ON "drop_claims"("paidAt", "attemptedAt");
