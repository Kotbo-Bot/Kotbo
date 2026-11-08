-- Type d'événement « Tournoi » : arbre à élimination directe, matchs en manches
-- gagnantes, page publique de suivi. Rejouable : chaque ajout est conditionnel.

ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'TOURNAMENT';

ALTER TABLE "custom_event_registrations" ADD COLUMN IF NOT EXISTS "seed" INTEGER;

CREATE TABLE IF NOT EXISTS "event_tournament_matches" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "player1Id" TEXT NOT NULL,
    "player2Id" TEXT NOT NULL,
    "score1" INTEGER NOT NULL DEFAULT 0,
    "score2" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_tournament_matches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "event_tournament_matches_eventId_round_position_key" ON "event_tournament_matches"("eventId", "round", "position");

DO $$ BEGIN
  ALTER TABLE "event_tournament_matches" ADD CONSTRAINT "event_tournament_matches_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
