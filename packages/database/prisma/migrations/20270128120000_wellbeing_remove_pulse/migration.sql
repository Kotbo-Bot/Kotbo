-- Météo du staff retirée : elle envoyait des messages privés en masse.
-- Ses compteurs anonymes et ses empreintes de vote disparaissent avec elle.
DROP TABLE IF EXISTS "wellbeing_pulse_voters";
DROP TABLE IF EXISTS "wellbeing_pulse_weeks";
ALTER TABLE "wellbeing_configs"
DROP COLUMN IF EXISTS "pulseEnabled",
DROP COLUMN IF EXISTS "pulseRoleIds",
DROP COLUMN IF EXISTS "pulseSentAt";
