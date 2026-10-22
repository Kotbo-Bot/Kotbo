-- Pulse : version du modèle de calcul et comparaison aux serveurs de même taille.
ALTER TABLE "pulse_snapshots" ADD COLUMN IF NOT EXISTS "modelVersion" INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS "pulse_snapshots_dateKey_totalMembers_idx" ON "pulse_snapshots"("dateKey", "totalMembers");
