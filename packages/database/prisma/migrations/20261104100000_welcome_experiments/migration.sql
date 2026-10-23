-- Tests A/B de l'accueil et répartition des arrivants entre leurs versions.
CREATE TABLE IF NOT EXISTS "welcome_experiments" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hypothesis" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "primaryMetric" TEXT NOT NULL DEFAULT 'retained_d7',
    "variants" JSONB NOT NULL,
    "winnerKey" TEXT,
    "startedAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "welcome_experiments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "welcome_experiments_guildId_status_idx" ON "welcome_experiments"("guildId", "status");
DO $$ BEGIN
    ALTER TABLE "welcome_experiments" ADD CONSTRAINT "welcome_experiments_guildId_fkey"
        FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "welcome_experiment_assignments" (
    "id" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "variantKey" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "welcome_experiment_assignments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "welcome_experiment_assignments_experimentId_userId_key" ON "welcome_experiment_assignments"("experimentId", "userId");
CREATE INDEX IF NOT EXISTS "welcome_experiment_assignments_experimentId_variantKey_idx" ON "welcome_experiment_assignments"("experimentId", "variantKey");
DO $$ BEGIN
    ALTER TABLE "welcome_experiment_assignments" ADD CONSTRAINT "welcome_experiment_assignments_experimentId_fkey"
        FOREIGN KEY ("experimentId") REFERENCES "welcome_experiments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
