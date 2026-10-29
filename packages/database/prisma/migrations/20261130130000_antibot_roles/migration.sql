-- Shield Update, vague 4 : rôles donnés aux bots à leur arrivée.
ALTER TABLE "automod_configs" ADD COLUMN IF NOT EXISTS "antiBotRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
