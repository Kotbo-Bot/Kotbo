# Centre de gestion : droits du dashboard par rôle

Le Centre de gestion règle, pour chaque fonctionnalité, ce que chaque rôle
Discord peut voir, modérer, configurer et supprimer. Les règles par rôle sont
dans `DashboardFeatureRoleAccess`, les fonctionnalités dans
`DashboardFeatureConfig` (créées à la première ouverture, depuis le registre des
modules et quelques clés historiques).

## Règle de fond

- **Sans règle de rôle** sur une fonctionnalité : la lecture suit l'accès au
  dashboard, et la configuration et la suppression suivent le droit de gérer les
  réglages du serveur.
- **Dès qu'une règle existe** : seuls les rôles listés ont les droits cochés. Un
  rôle sans ligne n'a rien.
- Les rôles de bots (rôles gérés) ne portent aucun droit ; leurs règles sont
  purgées à l'enregistrement.
- Les administrateurs ont tout, partout.

## Copier les droits d'un rôle

Dans la matrice, le panneau **Copier les droits d'un rôle** applique les droits
d'un rôle modèle à plusieurs rôles d'un coup, sur toutes les fonctionnalités.
Quand le modèle n'a aucune règle sur une fonctionnalité, la règle des cibles est
retirée : elles ne gardent pas un droit que le modèle n'a pas. La copie remplit
la matrice ; il faut ensuite **enregistrer** pour l'appliquer.

## Intégrations (clés MCP)

La fonctionnalité `mcp_integrations` regroupe la page Connecter une IA. Elle
reste réservée aux administrateurs tant qu'aucune règle n'existe ; une règle
« Configurer » sur un rôle lui ouvre la lecture et la gestion des clés. Voir
[`mcp-droits-et-outils.md`](./mcp-droits-et-outils.md).

## Rôles automatiques

L'onglet **Rôles automatiques** de la page Annonces (`/welcome/autoroles`)
réunit le rôle à l'arrivée, le rôle du tag du serveur et le rôle de statut, avec
une vue d'ensemble. Le rôle du tag s'y règle une seule fois : l'enregistrement
aligne aussi le réglage de Shield, qui le lit de son côté. Au chargement, un
ancien réglage qui n'existait que côté Shield est repris.

## Fiche membre par rôle

Les onglets de la fiche membre se règlent selon le rôle du staff qui la
consulte (disposition par rôle, `MemberCaseLayout`). L'onglet Bien-être est
confidentiel et réservé à la cellule bien-être, avec un accès exceptionnel
journalisé.
