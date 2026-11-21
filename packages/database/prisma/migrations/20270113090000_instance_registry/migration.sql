-- Licence des instances self-host : liste blanche + bail conserve localement.
ALTER TABLE "local_instance_identity" ADD COLUMN IF NOT EXISTS "licenseLease" TEXT;

CREATE TABLE IF NOT EXISTS "authorized_instances" (
    "botClientId"  TEXT NOT NULL,
    "label"        TEXT,
    "authorizedBy" TEXT NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt"    TIMESTAMP(3),
    "revokedBy"    TEXT,

    CONSTRAINT "authorized_instances_pkey" PRIMARY KEY ("botClientId")
);

CREATE INDEX IF NOT EXISTS "authorized_instances_revokedAt_idx" ON "authorized_instances"("revokedAt");
