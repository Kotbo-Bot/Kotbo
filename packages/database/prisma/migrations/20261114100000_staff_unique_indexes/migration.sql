-- Index uniques du staff, que le schema declare mais qu'aucune migration n'a poses.
--
-- `staff_members` et `staff_member_hierarchy_grades` sont nees d'un `db push`,
-- avant l'historique des migrations. Sur une base ou leurs index uniques manquent,
-- l'upsert de Prisma (ON CONFLICT) echoue avec 42P10 : ajouter un membre au staff
-- etait impossible. Le code ne depend plus de ces index (services/staff/staffRowUpsert.ts),
-- mais le schema les promet et ils empechent les doublons.
--
-- Idempotente : rien ne se passe si l'index existe deja. En cas de doublons, l'index
-- n'est pas pose et un avertissement le dit, plutot que de faire echouer le deploiement.

DO $$
BEGIN
  IF to_regclass('public."staff_members_guildId_userId_key"') IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM "staff_members" GROUP BY "guildId", "userId" HAVING COUNT(*) > 1
    ) THEN
      RAISE WARNING 'staff_members : doublons (guildId, userId) presents, index unique non pose';
    ELSE
      CREATE UNIQUE INDEX "staff_members_guildId_userId_key" ON "staff_members"("guildId", "userId");
    END IF;
  END IF;

  IF to_regclass('public."staff_member_hierarchy_grades_staffMemberId_hierarchyId_key"') IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM "staff_member_hierarchy_grades" GROUP BY "staffMemberId", "hierarchyId" HAVING COUNT(*) > 1
    ) THEN
      RAISE WARNING 'staff_member_hierarchy_grades : doublons (staffMemberId, hierarchyId) presents, index unique non pose';
    ELSE
      CREATE UNIQUE INDEX "staff_member_hierarchy_grades_staffMemberId_hierarchyId_key"
        ON "staff_member_hierarchy_grades"("staffMemberId", "hierarchyId");
    END IF;
  END IF;
END $$;
