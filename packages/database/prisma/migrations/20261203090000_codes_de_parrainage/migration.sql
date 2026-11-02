-- Codes de parrainage : l'essai gratuit n'est plus offert qu'avec un code.

CREATE TABLE "referral_codes" (
    "code" TEXT NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_codes_pkey" PRIMARY KEY ("code")
);

CREATE UNIQUE INDEX "referral_codes_discordUserId_key" ON "referral_codes"("discordUserId");

ALTER TABLE "billing_trials" ADD COLUMN "referralCode" TEXT;

CREATE INDEX "billing_trials_referralCode_idx" ON "billing_trials"("referralCode");
