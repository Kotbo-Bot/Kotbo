# Giveaways : conditions de participation

Chaque giveaway peut porter ses propres conditions, évaluées par un module pur
(`apps/bot/src/services/features/giveawayConditions.ts`) puis branchées sur la
base et Discord par `giveawayService.ts`. Un giveaway sans conditions
(`Giveaway.conditions` nul) est un ancien concours et suit encore les réglages
du serveur (`GiveawayConfig`).

## Types de conditions

| Famille | Conditions |
|---|---|
| Rôles | tous les rôles (`roles_all`), au moins un (`roles_any`), aucun (`roles_none`) |
| Ancienneté | du compte (`account_age`), sur le serveur (`member_age`), en jours |
| Profil | boost du serveur requis ou exclu, photo de profil, bannière, tag de serveur officiel, texte dans le pseudo du serveur, texte dans le statut personnalisé |
| Activité | messages et minutes de vocal, avec une période : total, 7 jours, 30 jours ou depuis le lancement du giveaway |
| Compteurs | invitations restées, niveau, XP, pièces, réputation (minimum) |
| Externe | vote Top.gg, présence dans un autre serveur |

La bio d'un profil n'existe pas dans cette liste : Discord ne l'expose pas aux
bots. La condition sur le statut ne se pose que si l'intent Presences est actif.
Une donnée inconnue laisse passer le membre, jamais l'inverse.

## Logique

Toutes les conditions sont obligatoires (ET), sauf celles qui partagent un
`group` : un groupe est satisfait dès qu'une des siennes l'est. Il n'y a pas
d'arbre libre. Quinze conditions au plus par giveaway.

## Ce que voit le participant

- La liste des conditions dans l'embed du giveaway.
- Un refus détaillé : toutes les conditions manquantes, pas seulement la première.
- Un bouton **Vérifier mes conditions** sous le message.

## Vérification

Les conditions sont vérifiées au clic, puis revérifiées avant le tirage et lors
d'un reroll : un gagnant devenu invalide est écarté et un autre est tiré.

## Événement Discord planifié

L'option `createEvent` crée un événement Discord planifié à la création du
giveaway. Elle est disponible depuis le dashboard, `/giveaway start`, les
modèles de giveaway et le MCP.

## Surfaces

- **Dashboard** : éditeur des conditions dans le formulaire de création.
- **Commande** : `/giveaway start` avec ses options de condition et d'événement.
- **Modèles** : les conditions et l'événement sont embarqués dans `GiveawayTemplate`.
- **MCP** : `create_giveaway`, `update_giveaway` et `get_giveaways`.

## Variables d'environnement

Le vote Top.gg demande `TOPGG_API_TOKEN` (facultatif : sans lui, la condition ne
peut pas être vérifiée). `TOPGG_API_VERSION=v0` bascule sur l'ancienne API.

## Limites connues

- Le vote Top.gg en API v1 n'a pas été éprouvé contre l'API réelle.
- La page publique des giveaways n'affiche pas encore les conditions.
- Les sauvegardes de configuration (presets) ne portent pas les conditions.
