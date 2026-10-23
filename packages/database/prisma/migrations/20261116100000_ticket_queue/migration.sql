-- File d'attente des tickets : quand le serveur a atteint une limite Discord
-- (500 salons, 50 par categorie, 1000 fils actifs), la creation echouait et le
-- membre repartait avec une erreur. Le ticket attend desormais au statut
-- QUEUED et se cree des qu'une place se libere, dans l'ordre d'arrivee.
-- Rejouable : chaque ajout est conditionnel.

ALTER TYPE "TicketStatus" ADD VALUE IF NOT EXISTS 'QUEUED';

ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "queuedAt" TIMESTAMP(3);
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "queueScope" TEXT;

CREATE INDEX IF NOT EXISTS "tickets_status_queuedAt_idx" ON "tickets"("status", "queuedAt");
