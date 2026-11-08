-- Automatisations : délais de récupération et variables persistantes.

CREATE TABLE "workflow_cooldowns" (
    "workflowId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_cooldowns_pkey" PRIMARY KEY ("workflowId", "nodeId", "subjectKey")
);

CREATE INDEX "workflow_cooldowns_until_idx" ON "workflow_cooldowns"("until");

ALTER TABLE "workflow_cooldowns"
  ADD CONSTRAINT "workflow_cooldowns_workflowId_fkey"
  FOREIGN KEY ("workflowId") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "workflow_variables" (
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_variables_pkey" PRIMARY KEY ("guildId", "name", "subjectKey")
);

ALTER TABLE "workflow_variables"
  ADD CONSTRAINT "workflow_variables_guildId_fkey"
  FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
