-- La table featured_guilds de production date d'avant 20261125100000 et porte
-- une colonne "updatedAt" NOT NULL sans défaut, inconnue du schéma Prisma :
-- chaque création de ligne par featuredGuildsService échouait (P2011).
-- Les installations neuves n'ont pas cette colonne, d'où la garde.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'featured_guilds' AND column_name = 'updatedAt'
  ) THEN
    ALTER TABLE "featured_guilds" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
  END IF;
END $$;
