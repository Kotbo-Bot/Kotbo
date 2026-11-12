-- Drops : le rôle mentionné peut être réservé aux jackpots.

ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "dropMentionJackpotOnly" BOOLEAN NOT NULL DEFAULT false;
