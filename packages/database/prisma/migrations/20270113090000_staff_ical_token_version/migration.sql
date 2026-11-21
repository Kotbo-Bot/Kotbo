-- Staff : version du lien iCal du planning (révocation d'un lien distribué).
ALTER TABLE "staff_members"
  ADD COLUMN IF NOT EXISTS "icalTokenVersion" INTEGER NOT NULL DEFAULT 0;
