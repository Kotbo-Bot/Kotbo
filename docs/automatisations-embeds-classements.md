# Automatisations : classements, embeds et nouvelles conditions

Ce document décrit les ajouts de la v10.1 au moteur d'automatisations
(`packages/shared/src/workflow`, `apps/bot/src/services/features/workflow`).

## Classements dans les textes

Le nœud de données `RankingInfo` (« Classements du serveur ») expose quatre
textes prêts à insérer, disponibles quel que soit le déclencheur :

| Jeton | Contenu |
|---|---|
| `{ranking.topMessagesMonth}` | Top 3 des messages du mois |
| `{ranking.topVoiceMonth}` | Top 3 du vocal du mois (minutes) |
| `{ranking.topThanksMonth}` | Top 3 des remerciements du mois |
| `{ranking.topXp}` | Top 3 du classement d'XP |

Chaque texte compte trois lignes au plus (`🥇 <@id> · 1 204 messages`) et reste
vide quand personne n'est classé. Le mois courant se compte en UTC, à partir du
premier jour. Les mentions s'affichent sans notifier, car les textes d'une
automatisation ne mentionnent jamais.

Usage typique : un déclencheur à heure fixe et l'action « Tenir un message à
jour » (`KeepMessage`) affichent chaque mois les membres les plus actifs.

Le calcul est dans `services/features/workflow/rankings.ts` ; le nœud n'est
évalué que lorsqu'un jeton `ranking.*` est utilisé, car la compilation ne
l'insère qu'à cette condition.

## Embeds enrichis

`SendEmbed` et `SendDM` partagent les mêmes éléments optionnels :

| Entrée | Rôle |
|---|---|
| Texte au-dessus de l'embed (`SendEmbed`) | Seul endroit où une mention notifie (membres et rôles, jamais `@everyone` ni `@here`) |
| Vignette | URL `https` d'une image |
| Grande image | URL `https` d'une image |
| Pied de page | Texte, 2 048 caractères au plus |
| Icône du pied de page | URL `https`, affichée seulement avec un pied de page |

Une URL qui n'est pas en `https` est ignorée sans erreur.

`SendDM` accepte désormais du texte, un embed (titre ou description renseignés)
ou les deux. Sans texte ni embed, l'action échoue avec « le texte est vide ».
Des messages privés fermés restent un cas normal, pas une erreur.

## Conditions sur le membre

`MemberInfo` expose deux sorties de plus, utilisables dans les conditions :

- **A une photo de profil** (`hasAvatar`) : faux avec l'avatar par défaut de
  Discord. Discord n'expose pas la bio d'un profil aux bots : aucune condition
  ne peut en dépendre.
- **Score de risque** (`riskScore`, 0 à 100) : le score de la fiche membre,
  fondé sur les warns pondérés, l'historique et la récidive, comptes liés
  compris. Il est calculé à chaque évaluation de `MemberInfo` (quelques
  requêtes), et vaut 0 en essai à blanc.

Les conditions simples correspondantes sont « le score de risque du membre est
supérieur à X » et « le membre a une photo de profil ».

## Déclencheurs

- **Vérification réussie** : à la fin d'un captcha ou d'une vérification de sécurité.
- **Alerte AegisAI** : quand AegisAI émet une alerte.
