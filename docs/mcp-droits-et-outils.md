# MCP : droits des clés et outils de la v10.1

## Droits par module

Une clé MCP garde ses permissions globales tant qu'aucune règle n'existe pour
elle. Dès qu'elle en a une, tout module sans règle lui est fermé. Les règles se
règlent dans la matrice du Centre de gestion, où les clés sont des lignes comme
les rôles.

Le droit demandé par un outil se lit dans son nom (`mcpToolRight`) :

| Préfixe | Droit |
|---|---|
| `get_`, `list_`, `search_`, `read_` | `canView` |
| `update_`, `set_`, `save_`, `reorder_` | `canConfigure` |
| `delete_`, `remove_`, `dissolve_`, `void_`, `revoke_`, `cancel_` | `canDelete` |
| le reste | `canModerate` |

Un outil dont le nom ne correspond à aucun module reste hors de cette garde. Le
rattachement est dans `apps/bot/src/api/mcp/toolModules.ts`.

## Page Intégrations restreignable

La page Connecter une IA (`/mcp-settings`) correspond à la fonctionnalité
`mcp_integrations` du Centre de gestion. Sans règle, seuls les administrateurs y
accèdent. Un rôle à qui l'on donne « Configurer » peut lire et gérer les clés
sans être administrateur ; la lecture exige aussi ce droit explicite.

## Anti-raid

- `get_antiraid_config` (permission `READ_MODERATION`) : détection de vague
  d'arrivées, action, durée du verrou, comptes trop récents, rôles rendus au
  retour, filtre anti-arnaque.
- `update_antiraid_config` (permission `WRITE_MEMBERS`) : seuls les champs
  fournis changent. Les bornes sont celles du dashboard.

| Champ | Valeurs |
|---|---|
| `action` | `LOCK`, `CAPTCHA`, `KICK` |
| `join_threshold` | 2 à 500 arrivées |
| `join_window_seconds` | 5 à 3 600 |
| `auto_disable_minutes` | 1 à 10 080 |
| `account_age_action` | `ALERT`, `KICK`, `BAN`, `JAIL`, `TEMPBAN` |
| `scam_filter_action` | `DELETE`, `DELETE_AND_WARN`, `DELETE_AND_TIMEOUT`, `DELETE_AND_BAN` |

L'état du raid mode (actif ou non) se lit mais ne se modifie pas par ces outils.

## Rôles : dégradé, holographique, icône

`create_role` et `update_role` acceptent :

- `gradient_end_color` : couleur d'arrivée, combinée à `color` (départ).
  Serveur boost niveau 3.
- `holographic` : style holographique, qui remplace les couleurs. Serveur boost
  niveau 3.
- `icon_url` : URL `https` d'une image. Serveur boost niveau 2.
- `unicode_emoji` : emoji Unicode, alternative à `icon_url`.

## Giveaways

`create_giveaway` et `update_giveaway` acceptent les conditions de participation
et l'événement Discord (voir [`giveaways-conditions.md`](./giveaways-conditions.md)).
