-- Droits des cles MCP par module (liste blanche par cle, comme les roles du staff).
CREATE TABLE "mcp_key_feature_accesses" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "featureKey" TEXT NOT NULL,
    "canView" BOOLEAN NOT NULL DEFAULT false,
    "canModerate" BOOLEAN NOT NULL DEFAULT false,
    "canConfigure" BOOLEAN NOT NULL DEFAULT false,
    "canDelete" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_key_feature_accesses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mcp_key_feature_accesses_keyId_featureKey_key" ON "mcp_key_feature_accesses"("keyId", "featureKey");
CREATE INDEX "mcp_key_feature_accesses_guildId_featureKey_idx" ON "mcp_key_feature_accesses"("guildId", "featureKey");

ALTER TABLE "mcp_key_feature_accesses" ADD CONSTRAINT "mcp_key_feature_accesses_keyId_fkey" FOREIGN KEY ("keyId") REFERENCES "mcp_api_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;
