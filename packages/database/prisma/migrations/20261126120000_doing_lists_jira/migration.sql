-- Listes de suivi façon Jira : clés de cartes (BOUT-12), types, estimation,
-- cartes parentes, liens entre cartes, commentaires et historique.

ALTER TABLE "doing_lists"
  ADD COLUMN IF NOT EXISTS "key" TEXT,
  ADD COLUMN IF NOT EXISTS "nextNumber" INTEGER NOT NULL DEFAULT 1;

-- Clé tirée du nom (4 premières lettres ou chiffres), suffixée d'un numéro
-- quand deux listes du serveur tomberaient sur la même.
WITH base AS (
  SELECT "id", "guildId",
    COALESCE(NULLIF(upper(left(regexp_replace("name", '[^A-Za-z0-9]', '', 'g'), 4)), ''), 'LS') AS k
  FROM "doing_lists" WHERE "key" IS NULL
), ranked AS (
  SELECT "id", k, row_number() OVER (PARTITION BY "guildId", k ORDER BY "id") AS rn FROM base
)
UPDATE "doing_lists" d
SET "key" = CASE WHEN r.rn = 1 THEN r.k ELSE r.k || r.rn END
FROM ranked r WHERE d."id" = r."id";

ALTER TABLE "doing_lists" ALTER COLUMN "key" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "doing_lists_guildId_key_key" ON "doing_lists"("guildId", "key");

ALTER TABLE "doing_list_items"
  ADD COLUMN IF NOT EXISTS "number" INTEGER,
  ADD COLUMN IF NOT EXISTS "type" TEXT NOT NULL DEFAULT 'TASK',
  ADD COLUMN IF NOT EXISTS "estimate" INTEGER,
  ADD COLUMN IF NOT EXISTS "parentId" TEXT;

-- Les cartes existantes sont numérotées dans leur ordre de création.
WITH numbered AS (
  SELECT "id", row_number() OVER (PARTITION BY "listId" ORDER BY "createdAt", "id") AS n
  FROM "doing_list_items" WHERE "number" IS NULL
)
UPDATE "doing_list_items" i SET "number" = numbered.n FROM numbered WHERE i."id" = numbered."id";

UPDATE "doing_lists" l
SET "nextNumber" = COALESCE((SELECT max("number") FROM "doing_list_items" i WHERE i."listId" = l."id"), 0) + 1;

ALTER TABLE "doing_list_items" ALTER COLUMN "number" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "doing_list_items_listId_number_key" ON "doing_list_items"("listId", "number");
CREATE INDEX IF NOT EXISTS "doing_list_items_parentId_idx" ON "doing_list_items"("parentId");

ALTER TABLE "doing_list_items" DROP CONSTRAINT IF EXISTS "doing_list_items_parentId_fkey";
ALTER TABLE "doing_list_items"
  ADD CONSTRAINT "doing_list_items_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "doing_list_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "doing_list_item_links" (
  "id" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "fromId" TEXT NOT NULL,
  "toId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "doing_list_item_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "doing_list_item_links_fromId_toId_type_key" ON "doing_list_item_links"("fromId", "toId", "type");
CREATE INDEX IF NOT EXISTS "doing_list_item_links_toId_idx" ON "doing_list_item_links"("toId");

ALTER TABLE "doing_list_item_links" DROP CONSTRAINT IF EXISTS "doing_list_item_links_fromId_fkey";
ALTER TABLE "doing_list_item_links"
  ADD CONSTRAINT "doing_list_item_links_fromId_fkey"
  FOREIGN KEY ("fromId") REFERENCES "doing_list_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "doing_list_item_links" DROP CONSTRAINT IF EXISTS "doing_list_item_links_toId_fkey";
ALTER TABLE "doing_list_item_links"
  ADD CONSTRAINT "doing_list_item_links_toId_fkey"
  FOREIGN KEY ("toId") REFERENCES "doing_list_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "doing_list_events" (
  "id" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "actorName" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "body" TEXT,
  "data" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "doing_list_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "doing_list_events_itemId_createdAt_idx" ON "doing_list_events"("itemId", "createdAt");

ALTER TABLE "doing_list_events" DROP CONSTRAINT IF EXISTS "doing_list_events_itemId_fkey";
ALTER TABLE "doing_list_events"
  ADD CONSTRAINT "doing_list_events_itemId_fkey"
  FOREIGN KEY ("itemId") REFERENCES "doing_list_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
