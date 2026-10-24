-- Sticky : renvoi après un délai d'inactivité du salon. Rejouable.

ALTER TABLE "sticky_messages"
    ADD COLUMN IF NOT EXISTS "idleRepostMinutes" INTEGER NOT NULL DEFAULT 0;
