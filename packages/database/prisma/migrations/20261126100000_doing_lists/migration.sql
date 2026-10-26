-- Listes de suivi (« doing lists ») reliées aux modules, et leurs éléments.
CREATE TABLE IF NOT EXISTS "doing_lists" (
  "id" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "modules" TEXT[],
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "doing_lists_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "doing_lists_guildId_idx" ON "doing_lists"("guildId");

ALTER TABLE "doing_lists" DROP CONSTRAINT IF EXISTS "doing_lists_guildId_fkey";
ALTER TABLE "doing_lists"
  ADD CONSTRAINT "doing_lists_guildId_fkey"
  FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "doing_list_items" (
  "id" TEXT NOT NULL,
  "listId" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'TODO',
  "position" INTEGER NOT NULL DEFAULT 0,
  "sourceModule" TEXT,
  "sourceId" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "doing_list_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "doing_list_items_listId_sourceModule_sourceId_key"
  ON "doing_list_items"("listId", "sourceModule", "sourceId");
CREATE INDEX IF NOT EXISTS "doing_list_items_listId_status_position_idx"
  ON "doing_list_items"("listId", "status", "position");
CREATE INDEX IF NOT EXISTS "doing_list_items_guildId_sourceModule_sourceId_idx"
  ON "doing_list_items"("guildId", "sourceModule", "sourceId");

ALTER TABLE "doing_list_items" DROP CONSTRAINT IF EXISTS "doing_list_items_listId_fkey";
ALTER TABLE "doing_list_items"
  ADD CONSTRAINT "doing_list_items_listId_fkey"
  FOREIGN KEY ("listId") REFERENCES "doing_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;
