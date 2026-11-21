-- YouTube : derniers identifiants vus par abonnement, pour ne pas réannoncer une vidéo déjà vue.
ALTER TABLE "youtube_channel_follows" ADD COLUMN IF NOT EXISTS "recentVideoIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
