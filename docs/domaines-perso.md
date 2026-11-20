# Dashboard sur le domaine d'un serveur

Un serveur en offre Plus peut ouvrir son dashboard sur son propre domaine
(`panel.monserveur.fr`), aux couleurs de son bot, avec connexion par sa propre
application Discord. Tout se règle depuis la page **Identité** du dashboard.

## Comment ça marche

1. Le serveur saisit son domaine. Kotbo n'en garde que le nom d'hôte, unique.
2. Il crée deux enregistrements DNS :
   - `CNAME <domaine> → CUSTOM_DOMAIN_TARGET` : le trafic arrive sur le VPS ;
   - `TXT _kotbo.<domaine> = kotbo-verify=<guildId>` : la preuve qu'il possède le domaine.
3. « Vérifier » contrôle les deux. Le domaine n'est servi que s'il est vérifié,
   que l'offre est Plus ou plus, et que le Client ID et le Client Secret de
   l'application Discord du serveur sont renseignés.
4. Traefik interroge `GET /api/internal/custom-domains/traefik?token=…` et
   reçoit, pour chaque domaine actif, trois routeurs : `/api` vers le bot, le
   reste vers la SPA, et `http` redirigé vers `https`. Il obtient lui-même le
   certificat Let's Encrypt (défi HTTP-01).
5. Sur ce domaine, la SPA appelle l'API sur sa propre origine (voir
   `resolveApiBase` dans `apps/dashboard/src/lib/api/client.ts`) : le cookie de
   session reste un cookie propriétaire, que Safari et Firefox acceptent.
6. La connexion utilise l'application Discord du serveur, avec l'URL de retour
   `https://<domaine>/api/auth/discord/callback`, qu'il déclare dans son
   portail développeur. Après connexion, le dashboard s'ouvre sur son serveur.

## Mise en place sur le VPS (une seule fois)

1. **DNS Kotbo** : un enregistrement `A custom.kotbo.fr → IP du VPS` (proxy
   Cloudflare désactivé). C'est la valeur de `CUSTOM_DOMAIN_TARGET`.
2. **Variables du bot** (Dokploy, application bot) :
   ```
   CUSTOM_DOMAIN_TARGET=custom.kotbo.fr
   CUSTOM_DOMAIN_PROVIDER_TOKEN=<longue chaîne aléatoire>
   CUSTOM_DOMAIN_API_UPSTREAM=http://<conteneur du bot>:8787
   CUSTOM_DOMAIN_DASHBOARD_UPSTREAM=http://<conteneur du dashboard>:80
   CUSTOM_DOMAIN_CERT_RESOLVER=letsencrypt
   ```
   Les noms de conteneur sont ceux du réseau `dokploy-network`.
3. **Traefik** (Dokploy → Traefik → `traefik.yml`), ajouter le fournisseur HTTP
   à côté du fournisseur `file` existant :
   ```yaml
   providers:
     http:
       endpoint: "http://<conteneur du bot>:8787/api/internal/custom-domains/traefik?token=<CUSTOM_DOMAIN_PROVIDER_TOKEN>"
       pollInterval: "30s"
   ```
   puis redémarrer Traefik. Les points d'entrée `web` / `websecure` et le
   résolveur `letsencrypt` sont ceux de Dokploy par défaut.
4. Appliquer la migration `20261227090000_custom_bot_domaine`.

### Variante : tout derrière le proxy Cloudflare (Cloudflare for SaaS)

Si `CLOUDFLARE_API_TOKEN` et `CLOUDFLARE_ZONE_ID` sont définis, Kotbo bascule
dans ce mode (comme GitHub Pages : le client crée un CNAME, Cloudflare sert et
chiffre). Le TXT `_kotbo.<domaine>` reste exigé comme preuve de propriété.

1. Cloudflare → zone `kotbo.fr` → **SSL/TLS → Noms d'hôte personnalisés** :
   activer la fonction (carte bancaire requise), origine de secours =
   `custom.kotbo.fr`.
2. `custom.kotbo.fr` repasse en **Proxied** (nuage orange). Mode SSL de la zone :
   **Full** (le certificat par défaut de Traefik suffit ; pas de Let's Encrypt).
3. Jeton API limité à la zone, permission « SSL and Certificates : Edit », et
   l'ID de zone, dans les variables du bot.
4. « Vérifier » crée le nom d'hôte chez Cloudflare au premier passage, puis lit
   son statut : le domaine est servi quand Cloudflare l'a vu et a émis le
   certificat (quelques minutes). Changer de domaine retire l'ancien nom d'hôte.

Sans ces deux variables, le mode direct ci-dessus reste actif.

## Limites connues

- Un domaine derrière le proxy Cloudflare (nuage orange) échoue à la
  vérification : ses IP ne sont pas celles de la cible, et Let's Encrypt ne
  pourrait pas valider le défi.
- Un domaine vérifié met jusqu'à une minute à être accepté par chaque
  processus de l'API (cache rafraîchi chaque minute).
- Une session ouverte sur un domaine perso ne se rafraîchit pas : elle dure
  sept jours, comme le jeton Discord, puis il faut se reconnecter.

## Bot perso complet (option « Ton propre bot »)

Par défaut, la page Identité applique le profil à Kotbo sur ce serveur
seulement (pseudo, avatar, bannière, bio de membre). Activer « Ton propre
bot » fait tourner le code Kotbo entier sous le token du serveur :

1. Le token est testé puis scellé ; l'ID de l'application en est déduit.
2. « Démarrer » crée ou met à jour l'instance `cb-<serveur>` (marque blanche,
   secrets scellés, `maxGuilds` 1) et le launcher la lance à chaud
   (message IPC `custom-instance-start`). Le statut se change sans relance
   (`custom-instance-presence`).
3. Le domaine perso doit être en ligne : une fois Kotbo parti, le serveur ne
   se gère plus que là, l'API de Kotbo ne le voyant plus.
4. Le serveur invite son bot (lien prérempli avec `guild_id`).
5. « Retirer Kotbo » rattache le serveur à l'instance (`Guild.instanceId`),
   puis Kotbo quitte le serveur. Traefik envoie alors `/api` du domaine vers
   le port de l'instance ; il faut se reconnecter une fois sur le domaine.

Chaque worker ne traite que les serveurs qui lui reviennent (garde de
`client.emit`, `utils/guildOwnership.ts`) : pendant la bascule, Kotbo et le
bot du serveur ne font rien en double. « Revenir à Kotbo » détache le
serveur et arrête l'instance ; il faut réinviter Kotbo avant.

Limites à connaître :

- Chaque bot perso lancé est un processus Kotbo complet (plusieurs centaines
  de Mo de RAM). La console `/admin/whitelabel` les liste avec leur état.
- Les tâches planifiées qui ne passent que par la base (sans salon Discord)
  tournent dans chaque processus : à vérifier avant d'ouvrir largement.
- Un rattachement fait dans un processus met jusqu'à 30 s à être vu des autres.
