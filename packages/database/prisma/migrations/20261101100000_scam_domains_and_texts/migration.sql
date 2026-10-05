-- AlterTable
ALTER TABLE "scam_image_hashes" ADD COLUMN     "ocrText" TEXT;

-- CreateTable
CREATE TABLE "scam_domains" (
    "id" TEXT NOT NULL,
    "guildId" TEXT,
    "domain" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'HONEYPOT',
    "hits" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scam_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scam_text_samples" (
    "id" TEXT NOT NULL,
    "guildId" TEXT,
    "fingerprint" TEXT NOT NULL,
    "sample" TEXT NOT NULL,
    "signals" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" TEXT NOT NULL DEFAULT 'HONEYPOT',
    "hits" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scam_text_samples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scam_domains_domain_idx" ON "scam_domains"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "scam_domains_guildId_domain_key" ON "scam_domains"("guildId", "domain");

-- CreateIndex
CREATE INDEX "scam_text_samples_fingerprint_idx" ON "scam_text_samples"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "scam_text_samples_guildId_fingerprint_key" ON "scam_text_samples"("guildId", "fingerprint");

-- Postgres traite deux NULL comme distincts : sans ces index partiels, la
-- contrainte ci-dessus n'empêche pas les doublons des lignes globales.
CREATE UNIQUE INDEX "scam_domains_global_domain_key" ON "scam_domains"("domain") WHERE "guildId" IS NULL;
CREATE UNIQUE INDEX "scam_text_samples_global_fingerprint_key" ON "scam_text_samples"("fingerprint") WHERE "guildId" IS NULL;

-- AddForeignKey
ALTER TABLE "scam_domains" ADD CONSTRAINT "scam_domains_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scam_text_samples" ADD CONSTRAINT "scam_text_samples_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
