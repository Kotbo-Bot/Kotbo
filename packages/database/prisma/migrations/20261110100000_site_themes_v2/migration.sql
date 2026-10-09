-- Thèmes v2 du site communautaire (façon serveur de jeu, clair et sombre).
-- Les anciens thèmes sont ramenés à leur équivalent ; le mode clair/sombre
-- qu'ils imposaient passe dans les réglages, sauf si le propriétaire en a déjà
-- choisi un. Le fond « dégradé » disparaît au profit du fond uni.
-- Rejouable sans effet : les anciens noms ne réapparaissent pas.

ALTER TABLE "community_sites" ALTER COLUMN "theme" SET DEFAULT 'azur';

UPDATE "community_sites"
SET "themeSettings" = jsonb_build_object('mode', CASE "theme"
      WHEN 'clair' THEN 'light'
      WHEN 'neon' THEN 'dark'
      WHEN 'nuit' THEN 'dark'
      WHEN 'arcade' THEN 'dark'
      ELSE 'auto'
    END) || "themeSettings",
    "theme" = CASE "theme"
      WHEN 'verre' THEN 'azur'
      WHEN 'clair' THEN 'azur'
      WHEN 'neon' THEN 'aurore'
      WHEN 'nuit' THEN 'documentation'
      WHEN 'arcade' THEN 'braise'
    END
WHERE "theme" IN ('verre', 'clair', 'neon', 'nuit', 'arcade');

UPDATE "community_sites"
SET "themeSettings" = "themeSettings" - 'background'
WHERE "themeSettings"->>'background' = 'gradient';
