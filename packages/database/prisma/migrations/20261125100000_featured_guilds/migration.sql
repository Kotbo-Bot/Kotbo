-- Serveurs mis en avant sur kotbo.fr, auparavant en dur dans routes/public/stats.ts.
-- Tenus à jour par featuredGuildsService.ts : les lignes ci-dessous ne servent
-- que jusqu'au premier passage, puis expirent si le bot n'y est plus.
CREATE TABLE IF NOT EXISTS "featured_guilds" (
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "iconUrl" TEXT,
    "memberCount" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "featured_guilds_pkey" PRIMARY KEY ("guildId")
);

CREATE INDEX IF NOT EXISTS "featured_guilds_memberCount_idx" ON "featured_guilds"("memberCount");
CREATE INDEX IF NOT EXISTS "featured_guilds_lastSeenAt_idx" ON "featured_guilds"("lastSeenAt");

INSERT INTO "featured_guilds" ("guildId", "name", "description", "iconUrl", "memberCount") VALUES
    ('506029988680695818', 'Communauté Minecraft Fr', 'Le plus grand serveur communautaire Minecraft francophone. Survie, mini-jeux et entraide au quotidien.', 'https://cdn.discordapp.com/icons/506029988680695818/6fbbb2b172d8677d849cee9c80485cf8.webp?size=128', 7690),
    ('913791560615854120', 'Jojo - Communauté', 'La communauté de Jojo est très accueillante ! Ici, vous pouvez discuter, échanger des idées ou même jouer ensemble.', 'https://cdn.discordapp.com/icons/913791560615854120/051ac19a35c8692f2ae8889ffa1fe7bf.webp?size=128', 4375),
    ('1386848639732809759', 'Zenode', 'Zenode - Serveur de Développement De Bots et Serveurs Discord, entraide autour de Discord.', 'https://cdn.discordapp.com/icons/1386848639732809759/e3e252b02264eb99b526afb1c8d93eb0.webp?size=128', 1846),
    ('1477350874740424986', 'Les nerds', 'Espace d''échange et d''entraide pour passionnés d''informatique, de programmation et de technologies.', 'https://cdn.discordapp.com/icons/1477350874740424986/61bd3237903270c5db2581a313f6a701.webp?size=128', 1109)
ON CONFLICT ("guildId") DO NOTHING;
