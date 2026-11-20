-- Suppression des Partenariats : le module n'est plus utilise. Tables et types disparaissent avec leurs donnees.

DROP TABLE IF EXISTS "partnership_applications" CASCADE;
DROP TABLE IF EXISTS "partnership_settings" CASCADE;
DROP TABLE IF EXISTS "partners" CASCADE;
DROP TABLE IF EXISTS "partner_contacts" CASCADE;
DROP TABLE IF EXISTS "partnerships" CASCADE;
DROP TABLE IF EXISTS "partnership_bridges" CASCADE;
DROP TABLE IF EXISTS "partnership_agreements" CASCADE;
DROP TABLE IF EXISTS "partnership_commitments" CASCADE;
DROP TABLE IF EXISTS "partnership_commitment_periods" CASCADE;
DROP TABLE IF EXISTS "partnership_benefits" CASCADE;
DROP TABLE IF EXISTS "partnership_benefit_grants" CASCADE;
DROP TABLE IF EXISTS "partnership_promotions" CASCADE;
DROP TABLE IF EXISTS "partnership_promotion_posts" CASCADE;
DROP TABLE IF EXISTS "partnership_reciprocity_checks" CASCADE;
DROP TABLE IF EXISTS "partnership_tracked_links" CASCADE;
DROP TABLE IF EXISTS "partnership_referrals" CASCADE;
DROP TABLE IF EXISTS "partnership_metric_daily" CASCADE;
DROP TABLE IF EXISTS "partnership_events" CASCADE;
DROP TABLE IF EXISTS "partnership_notes" CASCADE;
DROP TABLE IF EXISTS "partnership_documents" CASCADE;
DROP TABLE IF EXISTS "partnership_payments" CASCADE;
DROP TABLE IF EXISTS "partner_applications" CASCADE;
DROP TABLE IF EXISTS "partnership_guest_access" CASCADE;
DROP TABLE IF EXISTS "partnership_directory_listings" CASCADE;
DROP TABLE IF EXISTS "partnership_proposals" CASCADE;
DROP TABLE IF EXISTS "partnership_match_suggestions" CASCADE;
DROP TABLE IF EXISTS "partner_reputation_reports" CASCADE;
DROP TABLE IF EXISTS "partner_reputation_signals" CASCADE;
DROP TABLE IF EXISTS "partner_blocklist_entries" CASCADE;
DROP TABLE IF EXISTS "partnership_alert_states" CASCADE;

DROP TYPE IF EXISTS "PartnershipApplicationStatus";
DROP TYPE IF EXISTS "PartnershipScope";
DROP TYPE IF EXISTS "PartnershipParty";
DROP TYPE IF EXISTS "PartnershipDirection";
DROP TYPE IF EXISTS "PartnershipBenefitState";
DROP TYPE IF EXISTS "PartnershipCommitmentState";
DROP TYPE IF EXISTS "PartnershipPaymentStatus";
DROP TYPE IF EXISTS "PartnershipProposalStatus";
DROP TYPE IF EXISTS "PartnerApplicationStatus";
DROP TYPE IF EXISTS "PartnershipReciprocityResult";
DROP TYPE IF EXISTS "PartnershipAgreementState";

DELETE FROM "dashboard_feature_configs" WHERE "featureKey" = 'partnerships';
DELETE FROM "notification_preferences" WHERE "category" = 'partnerships';
