-- Threads d'accueil ouverts par le bot : la purge des threads inactifs ne supprime que ceux-là.
CREATE TABLE IF NOT EXISTS "welcome_threads_created" (
    "threadId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "welcome_threads_created_pkey" PRIMARY KEY ("threadId"),
    CONSTRAINT "welcome_threads_created_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "welcome_thread_configs"("guildId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "welcome_threads_created_guildId_idx" ON "welcome_threads_created"("guildId");
