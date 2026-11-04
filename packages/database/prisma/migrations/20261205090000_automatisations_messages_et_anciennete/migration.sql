-- Automatisations : messages tenus à jour et balayage de l'ancienneté et de l'inactivité.

CREATE TABLE "workflow_kept_messages" (
    "workflowId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_kept_messages_pkey" PRIMARY KEY ("workflowId", "nodeId")
);

ALTER TABLE "workflow_kept_messages"
  ADD CONSTRAINT "workflow_kept_messages_workflowId_fkey"
  FOREIGN KEY ("workflowId") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "workflow_sweeps" (
    "workflowId" TEXT NOT NULL,
    "sweptUntil" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_sweeps_pkey" PRIMARY KEY ("workflowId")
);

ALTER TABLE "workflow_sweeps"
  ADD CONSTRAINT "workflow_sweeps_workflowId_fkey"
  FOREIGN KEY ("workflowId") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Le balayage de l'inactivité lit les derniers messages par serveur.
CREATE INDEX IF NOT EXISTS "member_profiles_guildId_lastMessageAt_idx" ON "member_profiles"("guildId", "lastMessageAt");
