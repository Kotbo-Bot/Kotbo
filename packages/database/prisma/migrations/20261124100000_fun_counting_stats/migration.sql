-- Comptage : record, date du dernier nombre, message d'état et bilan par joueur.
ALTER TABLE "fun_game_states"
  ADD COLUMN IF NOT EXISTS "countingRecord" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "countingUpdatedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "countingStatusMessageId" TEXT;

-- Le record part du compte en cours pour ne pas afficher un record plus bas que le nombre actuel.
UPDATE "fun_game_states" SET "countingRecord" = "countingCurrent" WHERE "countingRecord" < "countingCurrent";

CREATE TABLE IF NOT EXISTS "fun_counting_players" (
  "guildId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "correct" INTEGER NOT NULL DEFAULT 0,
  "failed" INTEGER NOT NULL DEFAULT 0,
  "score" INTEGER NOT NULL DEFAULT 0,

  CONSTRAINT "fun_counting_players_pkey" PRIMARY KEY ("guildId", "userId")
);

CREATE INDEX IF NOT EXISTS "fun_counting_players_guildId_score_idx"
  ON "fun_counting_players"("guildId", "score");

ALTER TABLE "fun_counting_players"
  DROP CONSTRAINT IF EXISTS "fun_counting_players_guildId_fkey";
ALTER TABLE "fun_counting_players"
  ADD CONSTRAINT "fun_counting_players_guildId_fkey"
  FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
