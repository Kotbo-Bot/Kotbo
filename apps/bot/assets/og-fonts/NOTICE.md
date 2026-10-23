# Polices des cartes d'aperçu de lien

Les cartes 1200 × 630 rendues par `src/services/system/ogImageService.ts`
reprennent les polices du dashboard : Outfit pour les titres, Inter pour le
texte. Ce sont les fichiers de `@fontsource` (sous-ensemble latin), recopiés ici
parce que l'image Docker du bot n'embarque pas les dépendances du dashboard.

Ces polices ne sont pas produites par Kotbo. Elles sont sous licence SIL Open
Font License 1.1, dont la clause 2 autorise à les redistribuer avec un logiciel
à condition que chaque copie soit accompagnée de sa notice de copyright et de
sa licence : c'est le rôle des fichiers `<police>.OFL.txt`.

| Fichier | Famille | Détenteur du copyright |
|---|---|---|
| `outfit-latin-700-normal.woff2` | Outfit | The Outfit Project Authors |
| `inter-latin-400-normal.woff2` | Inter | The Inter Project Authors |
| `inter-latin-500-normal.woff2` | Inter | The Inter Project Authors |
| `inter-latin-600-normal.woff2` | Inter | The Inter Project Authors |

Un caractère hors du sous-ensemble latin (nom de serveur en cyrillique, emoji)
retombe sur DejaVu Sans, installée dans l'image par `DockerfileBot`.
