-- Starlight : le vote de l'auteur sur son propre message ne compte plus.
ALTER TABLE "starboard_configs" ADD COLUMN "ignoreAuthorVotes" BOOLEAN NOT NULL DEFAULT true;

-- Confessions : délai réglable par serveur, salon de publication et retrait par le staff.
ALTER TABLE "guilds" ADD COLUMN "funConfessionCooldownSeconds" INTEGER NOT NULL DEFAULT 60;

ALTER TABLE "confessions" ADD COLUMN "channelId" TEXT;
ALTER TABLE "confessions" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "confessions" ADD COLUMN "deletedBy" TEXT;
