-- Site communautaire : la galerie de thèmes partagés est retirée du produit
-- (allègement du 2026-10-12). Ses tables partent avec elle.
-- Rejouable : chaque suppression est conditionnelle.

DROP TABLE IF EXISTS "site_theme_reports";
DROP TABLE IF EXISTS "site_theme_installs";
DROP TABLE IF EXISTS "site_theme_shares";
