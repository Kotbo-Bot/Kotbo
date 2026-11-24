-- CreateTable
CREATE TABLE "wellbeing_case_attachments" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "addedById" TEXT NOT NULL,
    "addedByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wellbeing_case_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wellbeing_case_attachments_caseId_createdAt_idx" ON "wellbeing_case_attachments"("caseId", "createdAt");

-- AddForeignKey
ALTER TABLE "wellbeing_case_attachments" ADD CONSTRAINT "wellbeing_case_attachments_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "wellbeing_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
