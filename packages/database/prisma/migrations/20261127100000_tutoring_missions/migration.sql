-- Tutorat refait : un tutorat peut porter une liste de suivi de missions.
ALTER TABLE "testing_periods" ADD COLUMN IF NOT EXISTS "doingListId" TEXT;

ALTER TABLE "testing_periods" DROP CONSTRAINT IF EXISTS "testing_periods_doingListId_fkey";
ALTER TABLE "testing_periods"
  ADD CONSTRAINT "testing_periods_doingListId_fkey"
  FOREIGN KEY ("doingListId") REFERENCES "doing_lists"("id") ON DELETE SET NULL ON UPDATE CASCADE;
