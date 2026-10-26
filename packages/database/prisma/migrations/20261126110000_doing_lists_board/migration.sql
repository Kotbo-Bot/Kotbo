-- Listes de suivi en tableau : étapes personnalisables avec limite, détails des
-- cartes et lien vers la tâche du planning qui porte l'attribution.

CREATE TABLE IF NOT EXISTS "doing_list_columns" (
  "id" TEXT NOT NULL,
  "listId" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "wipLimit" INTEGER,
  "isDone" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "doing_list_columns_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "doing_list_columns_listId_position_idx" ON "doing_list_columns"("listId", "position");

ALTER TABLE "doing_list_columns" DROP CONSTRAINT IF EXISTS "doing_list_columns_listId_fkey";
ALTER TABLE "doing_list_columns"
  ADD CONSTRAINT "doing_list_columns_listId_fkey"
  FOREIGN KEY ("listId") REFERENCES "doing_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Les trois statuts fixes de la première version deviennent les trois étapes
-- de départ de chaque liste existante.
INSERT INTO "doing_list_columns" ("id", "listId", "guildId", "name", "position", "isDone", "updatedAt")
SELECT l."id" || '_' || s."key", l."id", l."guildId", s."name", s."position", s."isDone", CURRENT_TIMESTAMP
FROM "doing_lists" l
CROSS JOIN (VALUES ('todo', 'À faire', 0, false), ('doing', 'En cours', 1, false), ('done', 'Terminé', 2, true))
  AS s("key", "name", "position", "isDone")
ON CONFLICT ("id") DO NOTHING;

ALTER TABLE "doing_list_items"
  ADD COLUMN IF NOT EXISTS "columnId" TEXT,
  ADD COLUMN IF NOT EXISTS "description" TEXT,
  ADD COLUMN IF NOT EXISTS "priority" TEXT,
  ADD COLUMN IF NOT EXISTS "dueDate" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "checklist" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "staffTaskId" TEXT;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'doing_list_items' AND column_name = 'status') THEN
    UPDATE "doing_list_items" SET "columnId" = "listId" || '_' || lower("status") WHERE "columnId" IS NULL;
  END IF;
END $$;

ALTER TABLE "doing_list_items" ALTER COLUMN "columnId" SET NOT NULL;

DROP INDEX IF EXISTS "doing_list_items_listId_status_position_idx";
ALTER TABLE "doing_list_items" DROP COLUMN IF EXISTS "status";

CREATE INDEX IF NOT EXISTS "doing_list_items_columnId_position_idx" ON "doing_list_items"("columnId", "position");
CREATE UNIQUE INDEX IF NOT EXISTS "doing_list_items_staffTaskId_key" ON "doing_list_items"("staffTaskId");

ALTER TABLE "doing_list_items" DROP CONSTRAINT IF EXISTS "doing_list_items_columnId_fkey";
ALTER TABLE "doing_list_items"
  ADD CONSTRAINT "doing_list_items_columnId_fkey"
  FOREIGN KEY ("columnId") REFERENCES "doing_list_columns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "doing_list_items" DROP CONSTRAINT IF EXISTS "doing_list_items_staffTaskId_fkey";
ALTER TABLE "doing_list_items"
  ADD CONSTRAINT "doing_list_items_staffTaskId_fkey"
  FOREIGN KEY ("staffTaskId") REFERENCES "staff_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
