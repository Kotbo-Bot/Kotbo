-- Kotbo Vision : moins de fausses détections.

-- Correspondance incertaine : le message reste en place par défaut, le staff tranche.
ALTER TABLE "raid_protection_configs" ADD COLUMN IF NOT EXISTS "visionUncertainDelete" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "vision_reviews" ADD COLUMN IF NOT EXISTS "messageId" TEXT;

-- L'ancien détecteur de QR se déclenchait sur presque toute capture de texte et
-- rangeait ces images parmi les interdites. On retire ces entrées et leurs
-- variantes ; un vrai QR d'arnaque repassera par la vérification du staff.
DELETE FROM "scam_image_hashes"
WHERE "parentId" IN (SELECT "id" FROM "scam_image_hashes" WHERE "source" = 'QR');
DELETE FROM "scam_image_hashes" WHERE "source" = 'QR';
