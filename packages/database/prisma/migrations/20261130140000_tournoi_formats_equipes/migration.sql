-- Tournoi : plusieurs phases (poules, arbre des perdants, grande et petite
-- finale), détail des manches et inscription par équipes. Rejouable.

ALTER TABLE "custom_event_registrations" ADD COLUMN IF NOT EXISTS "teamName" TEXT;
ALTER TABLE "custom_event_registrations" ADD COLUMN IF NOT EXISTS "teamMemberIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "event_tournament_matches" ADD COLUMN IF NOT EXISTS "stage" TEXT NOT NULL DEFAULT 'W';
ALTER TABLE "event_tournament_matches" ADD COLUMN IF NOT EXISTS "sets" JSONB;

DROP INDEX IF EXISTS "event_tournament_matches_eventId_round_position_key";
CREATE UNIQUE INDEX IF NOT EXISTS "event_tournament_matches_eventId_stage_round_position_key" ON "event_tournament_matches"("eventId", "stage", "round", "position");
