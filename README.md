# Kotbo 🤖

[![Bun](https://img.shields.io/badge/Runtime-Bun-black?style=flat-square&logo=bun)](https://bun.sh/)
[![TypeScript](https://img.shields.io/badge/Language-TypeScript-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Discord.js](https://img.shields.io/badge/Library-Discord.js%20v14-5865F2?style=flat-square&logo=discord)](https://discord.js.org/)
[![Svelte 5](https://img.shields.io/badge/Dashboard-Svelte%205-FF3E00?style=flat-square&logo=svelte)](https://svelte.dev/)
[![Prisma](https://img.shields.io/badge/ORM-Prisma-2D3748?style=flat-square&logo=prisma)](https://www.prisma.io/)
[![TailwindCSS](https://img.shields.io/badge/Styling-TailwindCSS%204-06B6D4?style=flat-square&logo=tailwindcss)](https://tailwindcss.com/)
[![Sentry](https://img.shields.io/badge/Observability-Sentry-362D59?style=flat-square&logo=sentry)](https://sentry.io/)

> **Kotbo** est un bot Discord d'administration, de veille technologique et de gestion communautaire de dernière génération. Il centralise la veille (RSS, YouTube, GitHub), la modération avancée, un système de gestion RH du personnel (staff), la détection de doubles comptes, un module de tickets de support complet et des défis de code journaliers.

---

![License](https://img.shields.io/badge/License-Source--Available-orange)

> ⚠️ **Note sur la licence :** Le code de Kotbo est public pour permettre la transparence et les contributions communautaires. Cependant, l'auto-hébergement (self-hosting) et l'utilisation du code pour un usage personnel ou commercial sont strictement interdits sans autorisation.

## 🔑 Statut du Projet & Activation

> [!IMPORTANT]
> **Open Source mais Activation Restreinte (Usage Privé)**
> 
> Bien que le code source de Kotbo soit public et en libre consultation pour des raisons d'audit et de transparence, le code du bot est **strictement réservée et exploitable uniquement par son créateur ([Klaynight](https://github.com/Klaynight-dev))**.
> 
> Pour pouvoir ajouter et utiliser Kotbo sur un serveur Discord, celui-ci doit être explicitement activé en base de données.
> - **Processus d'activation** : Une fois le bot invité, toutes ses fonctionnalités restent bloquées. L'administrateur du serveur doit exécuter la commande slash `/activate <code>` en fournissant un code d'activation à usage unique.
> - **Comment l'obtenir ?** : Vous devez impérativement **contacter Klaynight** pour faire valider votre serveur et obtenir un jeton d'activation. Sans cette étape, le bot s'auto-bloquera et refusera de traiter toute commande ou événement sur votre serveur.

---

## 🛠️ La Stack Technique

Kotbo est architecturé sous forme de monorepo moderne géré par **Bun** :

| Composant | Technologie(s) utilisée(s) | Description |
| :--- | :--- | :--- |
| **Runtime & Package Manager** | [Bun](https://bun.sh/) | Vitesse d'exécution maximale, support natif de TypeScript et gestionnaire de paquets ultra-rapide. |
| **Langage** | [TypeScript](https://www.typescriptlang.org/) | Typage statique robuste pour le bot et le dashboard. |
| **API Discord** | [Discord.js v14](https://discord.js.org/) | Framework officiel d'interaction avec la Gateway Discord. |
| **Base de Données** | [PostgreSQL](https://www.postgresql.org/) | Base relationnelle performante pour stocker la configuration, les profils, les sanctions et les logs. |
| **ORM** | [Prisma](https://www.prisma.io/) | Modélisation claire, migrations versionnées et typage de schéma généré automatiquement. |
| **Queue & Cache** | [Redis](https://redis.io/) & [BullMQ](https://docs.bullmq.io/) | Gestion résiliente des files d'attente asynchrones pour le polling des flux RSS/YouTube et la mise en cache. |
| **Dashboard Frontend** | [Svelte 5](https://svelte.dev/) + [Vite](https://vite.dev/) | Interface d'administration réactive (Single Page Application) avec le compilateur Svelte 5. |
| **Design / Styles** | [TailwindCSS v4](https://tailwindcss.com/) | Utilisation du compilateur v4 ultra-performant pour des designs modernes et soignés. |
| **Observabilité** | [Sentry](https://sentry.io/) | Télémétrie, remontée d'erreurs en temps réel et suivi des performances côté Bot et Dashboard. |
| **Traduction** | LibreTranslate (Local / API) | Traduction automatique de la veille non francophone via une instance self-hostée par Docker. |
| **Planification** | `node-cron` | Gestion précise des tâches planifiées (digests, resets quotidiens, vérifications d'échéances). |

---

## ✨ Fonctionnalités Majeures

### 📰 Veille Technologique & Flux RSS
- **Polling RSS Automatique** : Récupération toutes les 5 minutes avec filtrage par mots-clés globaux ou spécifiques par flux (inclusions/exclusions).
- **Pipeline de Validation** : Les articles peuvent être envoyés dans un salon de modération privé où le staff valide, rejette ou demande une traduction d'un clic.
- **Auto-Publication** : Publication en salon public avec création automatique d'un fil de discussion (thread) structuré pour encourager les débats.
- **Abonnements Individuels** : Les membres du serveur peuvent s'abonner individuellement à un flux pour être notifiés directement par message privé (DM).

### 🎥 YouTube & GitHub Monitoring
- **YouTube** : Suivi des chaînes configurées avec distinction automatique entre vidéos classiques et YouTube Shorts (pings de rôles différents possibles).
- **GitHub Releases** : Surveillance automatique des nouveaux tags et versions logicielles sur les dépôts de votre choix.

### 👥 Gestion RH du Staff (Staff Management)
- **Structure Hiérarchique** : Gestion complète des grades du staff (Helper, Modérateur, Admin, etc.) avec niveaux de permission distincts.
- **Suivi d'Activité** : Enregistrement de la présence en réunion, de l'activité vocale et textuelle, et des signalements traités.
- **Périodes d'Essai & Mentorat** : Attribution d'un tuteur (mentor), suivi de la progression et génération de bilans automatiques.
- **Absences & Démissions** : Gestion des demandes d'absence avec `/absent` et de démission avec `/demission` directement intégrée dans le workflow du staff.
- **Organigramme libre** : canvas libre, séparateurs de rôle et rôle Discord commun par pôle, synchronisé automatiquement.
- **Fiche membre par rôle** : les onglets s'adaptent au rôle du staff, avec un onglet Bien-être confidentiel et accès exceptionnel journalisé.
- **Tutorat** : la validation d'un tutorat peut débloquer des modules.
- **Notes Managériales** : Carnet de notes privées `/note` réservé aux responsables du personnel pour un suivi individuel juste et documenté.

### 🔑 Détection & Liaison de Doubles Comptes (Alt Accounts)
- **Scan de Nouveauté** : Alerte immédiate du staff si un nouvel arrivant possède un compte créé très récemment (seuil personnalisable en jours).
- **Liaison Automatique & Manuelle** : Liaison officielle de deux comptes Discord par le staff ou par déclaration volontaire de l'utilisateur (`/dc report` de bonne foi).
- **Dashboard Centralisé** : Visualisation graphique des arbres de doubles comptes détectés et gestion des demandes de liaison en attente.

### 🎫 Système de Tickets de Support
- **Interface Boutons** : Embed d'ouverture de ticket dynamique et propre.
- **Attribution & Prise en Charge** : Attribution automatique ou manuelle, système de *claim* et d'escalade (overclaim) réservé au staff qualifié.
- **Transcripts Automatiques** : Sauvegarde propre de l'intégralité de la conversation au format HTML/JSON à la fermeture du ticket avec la commande `/transcript`.

### 🚨 Modération Robuste & Casier Judiciaire
- **Sanctions Standards** : Warns, Kicks, Timeouts temporaires et Bans (temporaires ou définitifs) enregistrés en base de données.
- **Commandes `/casier` & `/sanction`** : Historique complet des sanctions d'un utilisateur consultable via un embed clair ou un menu contextuel Discord.
- **Corbeille & restauration** : une sanction supprimée est gardée en instantané et restaurable par les administrateurs.
- **Rappel & gravité** : type « Rappel » (warn de poids 0 hors des seuils), gravité du warn par palier, bans temporaires jusqu'à un an.
- **AutoMod Discord** : déclenchements journalisés et warn automatique sur les règles du serveur.
- **Synchronisation Globale** : Propagation optionnelle des sanctions sur les différents serveurs liés pour limiter la récidive.

### 🎁 Giveaways & Quêtes
- **Giveaways à conditions** : rôles, ancienneté, profil, activité, vote Top.gg ou présence sur un autre serveur, combinables en ET avec des groupes « au moins une ». Bouton « Vérifier mes conditions » et revérification avant le tirage. Voir [`docs/giveaways-conditions.md`](./docs/giveaways-conditions.md).
- **Événement Discord planifié** : chaque giveaway peut créer son événement.
- **Quêtes unifiées** : un seul moteur pour les quêtes communautaires et celles du RPG, avec conditions, prérequis, dates, paliers et récompenses libres.

### 🌐 Réseaux de serveurs
- **Page Réseau** : un sous-serveur rejoint le principal avec une fusion sans perte, sous un seul abonnement. Le serveur staff lié hérite de l'offre du principal.

### 🤖 Automatisations & MCP
- **Automatisations** : classements du mois et d'XP dans les textes, embeds enrichis (vignette, image, pied de page) aussi en message privé, conditions sur la photo de profil et le score de risque, déclencheurs « Vérification réussie » et « Alerte AegisAI ». Voir [`docs/automatisations-embeds-classements.md`](./docs/automatisations-embeds-classements.md).
- **MCP** : droits par module sur les clés, page Intégrations restreignable à un rôle, configuration anti-raid complète, rôles avec dégradé, holographique et icône. Voir [`docs/mcp-droits-et-outils.md`](./docs/mcp-droits-et-outils.md).

### 💻 Code Police
- **Code Police** : Détecte les blocs de code mal formatés (envoyés sans balises markdown) et propose un reformatage automatique propre à l'utilisateur.

---

## 📁 Architecture du Projet

```text
Kotbo/
├── apps/
│   ├── bot/                # Application Discord.js (Bot & API Backend du Dashboard)
│   │   └── src/
│   │       ├── api/        # API Hono/HTTP et Socket.IO servant le dashboard
│   │       ├── commands/   # Définitions des commandes Slash
│   │       ├── events/     # Listeners d'événements Discord et tâches Cron
│   │       ├── handlers/   # Gestionnaires d'interactions (boutons, modals)
│   │       ├── services/   # Logique métier (RSS, YouTube, Tickets)
│   │       └── utils/      # Client Prisma, gestion du cache Redis, logs, embeds
│   │
│   └── dashboard/          # Frontend Web (Single Page Application)
│       └── src/
│           ├── lib/        # API calls, composants partagés, stores
│           └── pages/      # Pages (Configuration, AuditLogs, Staff, DoublesComptes)
│
├── packages/
│   └── database/           # Package de gestion de la BDD partagé
│       └── prisma/
│           ├── schema.prisma # Modèles Prisma (Guilds, Staff, Tickets, Sanctions, etc.)
│           └── migrations/   # Migrations SQL PostgreSQL versionnées
│
├── DockerfileBot           # Image Docker pour le bot
├── DockerfileDash          # Image Docker pour le dashboard
├── docker-compose.yml      # Dépendances locales de dev (PostgreSQL, Redis, LibreTranslate)
├── package.json            # Configuration root du monorepo
└── bun.lock                # Fichier lock de Bun
```

---

## 🚀 Installation & Développement

### 1) Prérequis
- [Bun](https://bun.sh/) installé sur votre machine.
- Une base de données [PostgreSQL](https://www.postgresql.org/).
- Une instance [Redis](https://redis.io/) active.
- Un jeton de Bot Discord (Token) avec tous les **Privileged Gateway Intents** activés sur le Discord Developer Portal.

### 2) Configuration
Installez les dépendances, puis copiez le fichier d'exemple et remplissez vos variables d'environnement :
```bash
bun install
cp .env.example .env
```

#### Variables d'environnement clés (`.env`)
```ini
# --- Discord config ---
DISCORD_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_bot_client_id
DISCORD_CLIENT_SECRET=your_oauth_client_secret
DISCORD_REDIRECT_URI=http://localhost:8787/api/auth/discord/callback
DISCORD_CLIENT_OWNER_ID=your_discord_user_id  # Permet de bypass l'activation sur vos propres serveurs
GUILD_ID=your_development_guild_id            # Si fourni, enregistre les commandes slash instantanément sur ce serveur

# --- Database & Redis ---
DATABASE_URL="postgresql://kotbo:kotbo@localhost:5433/kotbo?schema=public"
REDIS_URL="redis://localhost:6379"

# --- API & Security ---
DASHBOARD_URL=http://localhost:5173
JWT_SECRET=long_random_secret_used_to_encrypt_server_sessions
# Migration facultative des anciens JWT, à supprimer après la date ISO indiquée
AUTH_LEGACY_BEARER_UNTIL=2026-07-13T00:00:00Z

# --- Observabilité ---
BOT_SENTRY_DSN=your_sentry_dsn

# --- Traduction ---
LIBRETRANSLATE_URL=http://localhost:5001       # Port exposé par le profil Docker Compose
```

Les valeurs ci-dessus correspondent aux services fournis par `docker-compose.yml`. Si PostgreSQL, Redis ou LibreTranslate tournent directement sur votre machine, adaptez leurs hôtes et ports.

### 3) Base de données Prisma
Initialisez et appliquez le schéma sur votre base de données locale. La commande raccourcie exécute la génération du client, le push du schéma puis le seed :
```bash
bun setup
```

Les étapes peuvent aussi être lancées séparément :
```bash
bun db:generate
bun db:push
bun db:seed
```

### 4) Déploiement des commandes slash
Avant de lancer le bot pour la première fois (ou après chaque ajout/modification de commande), enregistrez les commandes auprès de l'API de Discord :
```bash
bun deploy-commands
```

### 5) Démarrage du projet en local
Vous pouvez lancer le bot et le dashboard simultanément ou séparément :
```bash
# Tout lancer en développement (Bot + Dashboard)
bun dev:all

# Lancer uniquement le bot Discord
bun dev:bot

# Lancer uniquement le dashboard web
bun dev:dashboard
```

### 6) Vérifications locales

Les commandes suivantes correspondent aux contrôles exécutés par le workflow de qualité :

```bash
bun test                 # Tests du bot
bun coverage:bot         # Tests et seuil minimal de couverture
bun lint                 # ESLint bot + dashboard
bun quality:bot          # Typecheck, lint, tests et couverture du bot
bun run --filter @kotbo/dashboard check
```

---

## 🐳 Déploiement Docker

Un fichier `docker-compose.yml` est disponible à la racine pour fournir les **dépendances de développement local**. Il est **entièrement optionnel** : si tu as déjà PostgreSQL et Redis sur ta machine, garde-les et ignore cette section - il te suffit de faire pointer `DATABASE_URL` et `REDIS_URL` vers tes instances. Le bot et le dashboard, eux, se lancent toujours avec `bun dev:all`.

```bash
docker compose up -d --wait   # ou bun services:up
```
Sans profil supplémentaire, cela démarrera :
1. Une base **PostgreSQL** sur le port `5433` (et non 5432, pour ne pas entrer en conflit avec une instance locale existante).
2. Un serveur **Redis** sur le port `6379`.

Le conteneur **LibreTranslate** est optionnel et n'est lancé qu'avec son profil :

```bash
docker compose --profile translation up -d --wait
```

Il est alors exposé sur le port `5001`.

Si tu utilises ce compose, pense à faire pointer `DATABASE_URL` sur le port `5433`.

Les images du bot et du dashboard se construisent séparément, via `DockerfileBot` et `DockerfileDash`.

---

## 📖 Liste des Commandes Slash

### 🔑 Système & Initialisation
* `/activate <code>` : Active le bot sur le serveur Discord actuel à l'aide d'un jeton d'activation.
* `/setup` : Assistant interactif de configuration initiale du serveur.
* `/config` : Ouvre le hub interactif de paramétrage (Boutons/Menus).
* `/info` : Affiche des informations et des statistiques sur l'instance de Kotbo.
* `/ping` : Mesure la latence du bot et de l'API Discord.
* `/help [commande]` : Menu d'aide dynamique avec autocomplétion.

### 🛡️ Modération & Sécurité (Staff requis)
* `/sanction` : Applique une sanction (warn, kick, timeout, ban) à un membre. *(Aussi accessible via menu contextuel sur un utilisateur)*.
* `/casier [membre]` : Affiche la fiche de modération et le casier judiciaire complet d'un utilisateur. *(Aussi accessible via menu contextuel)*.
* `/dc <subcommand>` :
  * `scan` : Analyse l'ancienneté des derniers arrivants sur le serveur.
  * `link` : Lie deux comptes suspectés d'appartenir à la même personne.
  * `unlink` : Rompt la liaison entre deux comptes.
  * `list` : Affiche la liste des comptes associés à un membre.
  * `report` : Permet à un membre de déclarer de bonne foi son compte principal.
* `/invites` : Liste les invitations suspectes ou les comptes créés sous un certain seuil.
* `/rescan` : Relance un scan complet des invitations ou des membres suspects.
* `/transcript` : Génère un fichier HTML et JSON de transcription complète du salon actuel.

### 👥 RH & Gestion du Personnel (Staff uniquement)
* `/absent <subcommand>` : Déclare, met à jour ou consulte les demandes d'absences des membres du staff.
* `/demission` : Lance la procédure sécurisée de démission pour un membre du staff.
* `/meeting <subcommand>` : Planifie, démarre, arrête ou gère le compte-rendu des réunions de staff.
* `/note <user> <message>` : Permet à la direction d'ajouter une note confidentielle dans le dossier d'un membre du staff.
* `/stats [user]` : Affiche les statistiques détaillées de productivité et de présence d'un staff.

### 📰 Veille & Utilitaires
* `/feed <subcommand>` : Ajoute, retire, configure, active/désactive, ou liste les flux RSS et chaînes YouTube surveillés.
* `/news submit <url>` : Propose manuellement un article de veille au comité de lecture/validation.
* `/post` : Permet de générer des annonces personnalisées ou d'interagir via des embeds soignés.
* `/ticket` : Commande d'administration pour gérer et configurer le système de tickets de support.
* `/serverstats` : Configure des salons vocaux dynamiques affichant des statistiques en temps réel.
* `/leaderboard` : Affiche les classements locaux (activité).
* `/epoch [date]` : Outil utilitaire convertissant des dates en formats de timestamps Discord (epoch).
* `/devutils <subcommand>` : Utilitaires pour développeurs (décodage Base64, validation JWT, hachage MD5/SHA256).
* `/excuse` : Génère une excuse de développeur aléatoire.
* `/status <url>` : Vérifie le statut HTTP et le temps de réponse d'un site web externe.

---

## 🛠️ Dépannage fréquent

### 1. Le bot ne répond pas à l'invitation
* Vérifiez que le bot est bien activé sur votre serveur. Si vous n'avez pas de jeton d'activation, contactez **Klaynight**.
* Assurez-vous que les variables `DISCORD_TOKEN` et `DISCORD_CLIENT_ID` sont correctes dans votre `.env`.
* Vérifiez la console de démarrage pour détecter d'éventuelles erreurs de connexion avec la base de données PostgreSQL ou Redis.

### 2. Les commandes slash ne s'affichent pas dans Discord
* Avez-vous lancé la commande `bun deploy-commands` ?
* Si vous n'avez pas spécifié de `GUILD_ID` dans le fichier `.env`, les commandes sont enregistrées globalement par Discord, ce qui peut nécessiter jusqu'à **1 heure** de propagation. Spécifiez le `GUILD_ID` de votre serveur de test pour un enregistrement instantané.

### 3. Les flux RSS ne se mettent pas à jour
* Regardez si le worker BullMQ tourne sans erreur.
* Vérifiez les logs avec `LOG_LEVEL=debug` pour analyser les retours de `rss-parser`.

---

## 📝 Licence

Développement privé sous licence libre. Le code source de **Kotbo** est en libre accès pour consultation mais son exploitation commerciale ou le déploiement public d'instances alternatives est restreint sans l'autorisation préalable de son auteur, **[Klaynight](https://github.com/Klaynight-dev)**.

### Ressources tierces redistribuées

Kotbo embarque des ressources qu'il n'a pas produites. Leurs licences sont propres à elles et s'appliquent en plus de celle ci-dessus, y compris dans une distribution commerciale.

* **Emojis des cartes de rang** : [Twemoji](https://github.com/jdecked/twemoji) par Twitter, Inc. et les contributeurs du projet, graphismes sous licence [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/), qui **exige cette attribution**. Détails dans `apps/bot/assets/rank-emojis/NOTICE.md`.
* **Polices des cartes de rang** : Lato, Poppins, Barlow, Kanit, PT Serif, Arvo et Space Mono, sous licence [SIL Open Font License 1.1](https://openfontlicense.org/), qui autorise leur redistribution et leur vente avec un logiciel. Détails et noms réservés dans `apps/bot/assets/rank-fonts/NOTICE.md`.
