/**
 * Les pages fonctionnalités déjà rédigées pour kotbo.fr avant qu'elles ne se
 * gèrent depuis la console admin, reprises telles quelles du site vitrine
 * (`src/lib/data/features.ts`). L'import les crée publiées : le site ne perd
 * aucune page en passant à l'API.
 *
 * La question « Est-ce gratuit ? » n'y est pas : le site l'ajoute lui-même à
 * chaque page, avec la durée d'essai à jour.
 *
 * Fichier généré une fois ; les pages se modifient ensuite dans le dashboard.
 */
import type { FeaturePageSeed } from './featurePageService.js';

export const RICH_FEATURE_PAGE_SEEDS: FeaturePageSeed[] = 
[
  {
    "key": "automod",
    "slug": {
      "fr": "automod-discord",
      "en": "discord-automod"
    },
    "modules": [
      "AutoMod",
      "Protection anti-raid",
      "Anti-raid protection"
    ],
    "position": 0,
    "content": {
      "fr": {
        "name": "AutoMod et anti-raid",
        "title": "Bot Discord de modération : AutoMod et anti-raid · Kotbo",
        "description": "Règle l'AutoMod natif de Discord depuis un dashboard, puis ajoute ce qu'il ne fait pas : anti-spam, anti-raid, captcha et salon piège à bots de spam.",
        "h1": "Un bot Discord de modération qui règle l'AutoMod pour toi",
        "lead": "Kotbo crée pour toi les règles de l'AutoMod natif de Discord, et couvre ce qu'il laisse passer : le spam, les mentions en rafale, les raids et les comptes de spam.",
        "sections": [
          {
            "h2": "Les règles natives, sans le menu de Discord",
            "body": "Tu actives une règle dans le dashboard, Kotbo l'écrit côté Discord. Elle bloque le message avant sa publication, comme si tu l'avais créée à la main.",
            "points": [
              "Mots interdits, avec une liste d'exceptions",
              "Filtres d'insultes, de contenu sexuel et d'injures fournis par Discord",
              "Invitations vers d'autres serveurs, sauf ceux que tu autorises",
              "Au choix : bloquer le message, exclure temporairement ou alerter le staff"
            ]
          },
          {
            "h2": "Ce que l'AutoMod de Discord ne voit pas",
            "body": "Discord filtre des mots. Kotbo surveille aussi les comportements :",
            "points": [
              "Spam : trop de messages en quelques secondes",
              "Liens, avec une liste de domaines autorisés",
              "Messages en majuscules, emojis et mentions en rafale",
              "Ghost pings et @everyone abusifs"
            ]
          },
          {
            "h2": "Anti-raid : la vague d'arrivées repérée et arrêtée",
            "body": "Tu fixes le seuil, par exemple 10 arrivées en 60 secondes. Au-delà, Kotbo passe en mode raid : il bloque les arrivées, impose un captcha ou exclut les nouveaux venus, prévient le staff, puis lève le mode raid tout seul après la durée choisie.",
            "points": [
              "Captcha en image, ou en vocal : le bot énonce le code dans un salon vocal",
              "Âge minimal du compte Discord pour entrer",
              "Mode raid à déclencher à la main quand tu sens venir le coup"
            ]
          },
          {
            "h2": "Le salon piège contre les comptes de spam",
            "body": "Un salon que personne ne lit, où seuls les bots de spam écrivent. Le premier message posté dedans déclenche la sanction que tu as choisie. Le staff et les administrateurs ne sont jamais piégés."
          }
        ],
        "faq": [
          {
            "q": "Comment configurer l'AutoMod sur Discord ?",
            "a": "Dans Discord, l'AutoMod se règle dans les paramètres du serveur, rubrique AutoMod. Avec Kotbo, tu actives les mêmes règles depuis le dashboard : Kotbo les crée côté Discord, et tu règles au même endroit l'anti-spam, l'anti-raid et le captcha."
          },
          {
            "q": "Kotbo remplace-t-il l'AutoMod de Discord ?",
            "a": "Non, il s'appuie dessus. Les filtres de mots, d'insultes et d'invitations restent des règles natives de Discord, que Kotbo pilote. Le spam, les liens, les raids et le captcha sont gérés par Kotbo."
          }
        ]
      },
      "en": {
        "name": "AutoMod and anti-raid",
        "title": "Discord moderation bot: AutoMod setup and anti-raid · Kotbo",
        "description": "Set up Discord's native AutoMod rules from a dashboard, then add what it can't do: anti-spam, anti-raid, captcha and a honeypot channel for spam bots.",
        "h1": "A Discord moderation bot that sets up AutoMod for you",
        "lead": "Kotbo writes Discord's native AutoMod rules for you, and covers what they let through: spam, mass mentions, raids and spam accounts.",
        "sections": [
          {
            "h2": "Native rules, without Discord's menus",
            "body": "Turn a rule on in the dashboard and Kotbo creates it on Discord. It blocks the message before it is posted, exactly as if you had built it by hand.",
            "points": [
              "Blocked words, with an allow list",
              "Discord's profanity, sexual content and slur filters",
              "Invites to other servers, except the ones you allow",
              "Your choice of action: block the message, time the member out, or alert staff"
            ]
          },
          {
            "h2": "What Discord's AutoMod doesn't catch",
            "body": "Discord filters words. Kotbo also watches behavior:",
            "points": [
              "Spam: too many messages in a few seconds",
              "Links, with a list of allowed domains",
              "All-caps messages, emoji floods and mass mentions",
              "Ghost pings and @everyone abuse"
            ]
          },
          {
            "h2": "Anti-raid: join waves spotted and stopped",
            "body": "You set the threshold, say 10 joins in 60 seconds. Past it, Kotbo enters raid mode: it locks joins, forces a captcha or kicks newcomers, alerts staff, then lifts raid mode on its own after the time you chose.",
            "points": [
              "Image captcha, or voice: the bot reads the code out in a voice channel",
              "Minimum Discord account age to join",
              "Manual raid mode when you see one coming"
            ]
          },
          {
            "h2": "A honeypot channel for spam accounts",
            "body": "A channel nobody reads, where only spam bots post. The first message in it triggers the sanction you picked. Staff and administrators are never caught."
          }
        ],
        "faq": [
          {
            "q": "How do I set up AutoMod on Discord?",
            "a": "In Discord, AutoMod lives in your server settings, under AutoMod. With Kotbo, you turn the same rules on from the dashboard: Kotbo creates them on Discord, and you set up anti-spam, anti-raid and captcha in the same place."
          },
          {
            "q": "Does Kotbo replace Discord's AutoMod?",
            "a": "No, it builds on it. Word, profanity and invite filters stay native Discord rules that Kotbo manages. Spam, links, raids and captcha are handled by Kotbo."
          }
        ]
      }
    }
  },
  {
    "key": "double_accounts",
    "slug": {
      "fr": "detection-doubles-comptes",
      "en": "alt-account-detection"
    },
    "modules": [
      "Doubles comptes",
      "Alt accounts"
    ],
    "position": 1,
    "content": {
      "fr": {
        "name": "Détecteur de doubles comptes",
        "title": "Détecteur de doubles comptes Discord gratuit · Kotbo",
        "description": "Détecteur de doubles comptes Discord gratuit : Kotbo repère les alts à l'arrivée (profil, invitations, écriture, horaires, appareil). Le staff tranche.",
        "h1": "Détecteur de doubles comptes Discord : repère les alts avant qu'ils contournent un ban",
        "lead": "Un membre banni revient avec un autre compte ? Kotbo est un alt checker qui tourne dans ton serveur : il compare chaque nouvel arrivant aux membres déjà présents et signale au staff les ressemblances qui comptent, avec les raisons du soupçon. Il est gratuit, et il ne bannit jamais tout seul.",
        "sections": [
          {
            "h2": "Comment fonctionne le détecteur d'alts",
            "body": "Tu ajoutes Kotbo, tu actives la détection dans le dashboard, et elle tourne à chaque arrivée.",
            "points": [
              "Un membre arrive : Kotbo compare son compte à tous ceux déjà présents sur le serveur",
              "Les indices de natures différentes s'additionnent en un niveau de risque : faible, moyen ou élevé",
              "Le staff lit les indices, puis lie les comptes ou écarte l'alerte",
              "Un scan peut aussi passer en revue les membres déjà là, pour repérer les alts arrivés avant l'activation"
            ]
          },
          {
            "h2": "Ce que Kotbo compare",
            "body": "Aucun indice ne suffit seul. Kotbo les combine, et des indices de natures différentes qui concordent pèsent bien plus lourd que deux indices du même genre.",
            "points": [
              "Le profil : âge du compte, pseudo proche, même avatar",
              "Qui l'a vraiment invité, y compris quand l'invitation a été validée par le staff",
              "Le style d'écriture, les horaires d'activité, les personnes mentionnées",
              "Deux comptes jamais actifs en même temps, ou qui se relaient en vocal",
              "Avec la vérification par lien : même appareil, même adresse IP ou même réseau, comptes connectés en commun"
            ]
          },
          {
            "h2": "Vérifier un alt par ID ou sur un site : ce qu'il faut savoir",
            "body": "Kotbo n'est pas un site où l'on colle un ID pour connaître les alts de n'importe qui. Discord n'expose pas le lien entre deux comptes : un outil qui prétend le deviner depuis un ID seul ne peut pas le savoir. Kotbo travaille dans ton serveur, là où il peut comparer de vraies données : invitations, activité, vérification. Dans le dashboard, tu retrouves chaque détection par pseudo ou par ID."
          },
          {
            "h2": "Le staff tranche, la détection apprend",
            "body": "Kotbo ne bannit pas sur un soupçon. Il propose, et le staff lie les comptes ou écarte l'alerte. Chaque décision ajuste le poids des indices pour ton serveur, et un petit serveur profite de ce que les autres ont déjà appris."
          },
          {
            "h2": "Les comptes liés, au même endroit",
            "body": "Une fois liés, les comptes se consultent ensemble dans le dashboard, avec l'historique de chacun."
          },
          {
            "h2": "Activer la détection en quelques minutes",
            "body": "Tout se règle dans le dashboard.",
            "points": [
              "Ajoute Kotbo, puis ouvre la page Comptes suspects, dans la section Protection",
              "Active la détection automatique et règle le seuil : plus il est bas, plus tu verras de cas à vérifier",
              "Choisis si tu veux un rôle de validation et un rôle de sanction",
              "En option, active la vérification par lien et l'enregistrement des messages pour des indices plus solides"
            ]
          }
        ],
        "faq": [
          {
            "q": "Comment savoir si quelqu'un a un double compte sur Discord ?",
            "a": "Discord ne le montre pas. Les indices sont ailleurs : même façon d'écrire, horaires qui ne se chevauchent jamais, même personne qui invite. Kotbo les relève à chaque arrivée et prévient le staff."
          },
          {
            "q": "Peut-on vérifier les alts d'un utilisateur avec son ID ou sur un site ?",
            "a": "Non, aucun site ne peut le faire de façon fiable : Discord n'expose pas le lien entre deux comptes. Kotbo compare les comptes à l'intérieur de ton serveur, avec les invitations, l'activité et la vérification, puis te montre les raisons de chaque soupçon."
          },
          {
            "q": "Faut-il une vérification pour que la détection marche ?",
            "a": "Non. Les indices de profil et d'invitation marchent sans rien demander aux membres, ceux de comportement dès que l'enregistrement des messages est activé. La vérification par lien ajoute les indices techniques : appareil et adresse IP."
          },
          {
            "q": "Kotbo bannit-il les alts automatiquement ?",
            "a": "Non. Un score élevé est un soupçon, pas une preuve. Kotbo signale, et c'est le staff qui confirme le lien ou rejette l'alerte."
          },
          {
            "q": "Comment empêcher un membre banni de revenir avec un autre compte ?",
            "a": "Aucun outil ne l'empêche à coup sûr. Kotbo repère les arrivées qui ressemblent à un compte déjà connu, et ton staff les vérifie avant qu'elles ne causent des dégâts."
          },
          {
            "q": "Kotbo est-il une alternative à Double Counter ou Altdentifier ?",
            "a": "Oui pour la détection des alts : Kotbo compare des indices de profil, d'invitation et de comportement, et propose aussi une vérification par lien qui compare appareils et adresses IP. La détection fait partie d'un bot complet, avec la modération, les logs et les tickets : pas besoin d'un bot de plus."
          }
        ]
      },
      "en": {
        "name": "Discord alt checker",
        "title": "Free Discord Alt Checker: Detect Alt Accounts · Kotbo",
        "description": "A free Discord alt checker that flags alt accounts when they join: profile, invites, writing style, activity hours and device. Staff decides, no auto-ban.",
        "h1": "Free Discord alt checker: catch alt accounts before they dodge a ban",
        "lead": "Looking for a Discord alt finder? Kotbo is an alt detector that runs inside your server. It compares every newcomer with the members already there and flags the likely alts to your staff, with the reasons behind each flag. It is free, and it never bans on its own.",
        "sections": [
          {
            "h2": "How the alt checker works",
            "body": "Add Kotbo, turn detection on in the dashboard, and it runs on every join.",
            "points": [
              "A member joins: Kotbo compares the account with everyone already on your server",
              "Clues of different kinds add up to a risk level: low, medium or high",
              "Staff reads the clues, then links the accounts or dismisses the alert",
              "A scan can also review the members already there, to catch alts that joined before you turned it on"
            ]
          },
          {
            "h2": "What the alt detector compares",
            "body": "No single clue is enough. Kotbo combines them, and clues of different kinds that agree weigh far more than two clues of the same kind.",
            "points": [
              "Profile: account age, similar username, same avatar",
              "Who actually invited them, even when staff approved the invite",
              "Writing style, activity hours, who they mention",
              "Two accounts never online at the same time, or taking turns in voice",
              "With link verification: same device, same IP or network, shared connected accounts"
            ]
          },
          {
            "h2": "Checking alts by user ID or on a website: what to expect",
            "body": "Kotbo is not a website where you paste a user ID to see anyone's alts. Discord doesn't expose the link between two accounts, so a tool that claims to guess it from an ID alone can't know. Kotbo works inside your server, where it can compare real data: invites, activity, verification. In the dashboard, you find each detection by name or ID."
          },
          {
            "h2": "Staff decides, detection learns",
            "body": "Kotbo never bans on a hunch. It suggests, and staff links the accounts or dismisses the alert. Each decision tunes the weight of each clue for your server, and small servers benefit from what the others have already learned."
          },
          {
            "h2": "Linked accounts in one place",
            "body": "Once linked, accounts can be reviewed together in the dashboard, with each one's history."
          },
          {
            "h2": "Turn it on in a few minutes",
            "body": "Everything is set in the dashboard.",
            "points": [
              "Add Kotbo, then open the Suspect accounts page, under Protection",
              "Turn on automatic detection and set the threshold: the lower it is, the more cases you'll have to check",
              "Pick a validation role and a sanction role if you want them",
              "Optionally, turn on link verification and message logging for stronger clues"
            ]
          }
        ],
        "faq": [
          {
            "q": "How can I tell if someone has an alt account on Discord?",
            "a": "Discord doesn't show it. The clues are elsewhere: the same way of writing, activity hours that never overlap, the same person inviting. Kotbo picks them up on every join and alerts staff."
          },
          {
            "q": "Can I check someone's alts by user ID or on a website?",
            "a": "Not reliably: Discord doesn't expose the link between two accounts, so no website can tell. Kotbo compares accounts inside your server, using invites, activity and verification, and shows you the reasons behind every suspicion."
          },
          {
            "q": "Does detection need a verification step?",
            "a": "No. Profile and invite clues work without asking members anything, behavior clues as soon as message logging is on. Link verification adds the technical clues: device and IP address."
          },
          {
            "q": "Does Kotbo ban alts automatically?",
            "a": "No. A high score is a suspicion, not proof. Kotbo flags, and staff confirms the link or dismisses the alert."
          },
          {
            "q": "How do I stop a banned member from coming back with another account?",
            "a": "No tool stops it for sure. Kotbo spots arrivals that look like an account it already knows, and your staff can check them before they cause damage."
          },
          {
            "q": "Is Kotbo an alternative to Double Counter or Altdentifier?",
            "a": "For alt detection, yes: Kotbo compares profile, invite and behavior clues, and also offers link verification that compares devices and IP addresses. Detection is part of a full bot, with moderation, logs and tickets, so you don't need one more bot."
          }
        ]
      }
    }
  },
  {
    "key": "logs",
    "slug": {
      "fr": "logs-discord",
      "en": "discord-logs"
    },
    "modules": [
      "Logs Discord",
      "Discord logs"
    ],
    "position": 2,
    "content": {
      "fr": {
        "name": "Logs Discord",
        "title": "Bot de logs Discord : messages supprimés, rôles, vocal · Kotbo",
        "description": "Un salon de logs complet pour ton serveur Discord : messages supprimés et modifiés, arrivées, rôles, salons, invitations, vocal et journal d'audit, dans un dashboard.",
        "h1": "Un bot de logs Discord qui dit qui a fait quoi",
        "lead": "Le journal d'audit de Discord ne garde ni le contenu des messages supprimés, ni plus de 45 jours d'historique. Kotbo enregistre ce qui se passe sur ton serveur, l'envoie dans ton salon de logs et le garde consultable dans le dashboard.",
        "sections": [
          {
            "h2": "Ce qui est enregistré",
            "body": "Tout ce qui change sur le serveur, au même endroit :",
            "points": [
              "Messages supprimés et modifiés, y compris les suppressions en masse",
              "Arrivées et départs des membres",
              "Rôles et pseudos des membres",
              "Salons et rôles créés, modifiés ou supprimés",
              "Invitations créées et supprimées",
              "Vocal : arrivées, départs et changements de salon",
              "Fils créés et entrées du journal d'audit de Discord"
            ]
          },
          {
            "h2": "Les logs de modération, à part",
            "body": "Chaque sanction est consignée avec son auteur et sa raison. Si ton staff a son propre serveur, Kotbo peut y recopier les logs de modération."
          },
          {
            "h2": "Un salon de logs qui reste lisible",
            "body": "Tu choisis les salons à ignorer, comme celui des commandes de bots, pour que le salon de logs ne se noie pas. Dans le dashboard, les logs se filtrent par type et se recherchent."
          }
        ],
        "faq": [
          {
            "q": "Comment voir les logs d'un serveur Discord ?",
            "a": "Discord propose un journal d'audit dans les paramètres du serveur, mais il ne garde pas le contenu des messages supprimés et s'efface au bout de 45 jours. Un bot de logs comme Kotbo enregistre tout dans un salon dédié et dans son dashboard."
          },
          {
            "q": "Comment voir un message supprimé sur Discord ?",
            "a": "Discord ne le permet pas. Si Kotbo était sur le serveur au moment de la suppression, le message apparaît dans le salon de logs avec son contenu et son auteur."
          }
        ]
      },
      "en": {
        "name": "Discord logs",
        "title": "Discord logging bot: deleted messages and mod log · Kotbo",
        "description": "A complete log channel for your Discord server: deleted and edited messages, joins, roles, channels, invites, voice and audit log, searchable in a dashboard.",
        "h1": "A Discord logging bot that tells you who did what",
        "lead": "Discord's audit log keeps neither the content of deleted messages nor more than 45 days of history. Kotbo records what happens on your server, posts it to your log channel and keeps it searchable in the dashboard.",
        "sections": [
          {
            "h2": "What gets logged",
            "body": "Everything that changes on the server, in one place:",
            "points": [
              "Deleted and edited messages, bulk deletes included",
              "Member joins and leaves",
              "Member roles and nicknames",
              "Channels and roles created, edited or deleted",
              "Invites created and deleted",
              "Voice: joins, leaves and channel moves",
              "New threads and Discord audit log entries"
            ]
          },
          {
            "h2": "A separate mod log",
            "body": "Every sanction is recorded with who issued it and why. If your staff has its own server, Kotbo can mirror the mod log there."
          },
          {
            "h2": "A log channel that stays readable",
            "body": "Pick the channels to ignore, like the bot commands channel, so the log channel doesn't drown. In the dashboard, logs filter by type and are searchable."
          }
        ],
        "faq": [
          {
            "q": "How do I check the logs of a Discord server?",
            "a": "Discord has an audit log in server settings, but it doesn't keep the content of deleted messages and clears after 45 days. A logging bot like Kotbo records everything in a dedicated channel and in its dashboard."
          },
          {
            "q": "How can I see a deleted message on Discord?",
            "a": "Discord doesn't allow it. If Kotbo was on the server when the message was deleted, it shows up in the log channel with its content and author."
          }
        ]
      }
    }
  },
  {
    "key": "tickets",
    "slug": {
      "fr": "tickets-discord",
      "en": "discord-tickets"
    },
    "modules": [
      "Tickets support",
      "Support tickets"
    ],
    "position": 3,
    "content": {
      "fr": {
        "name": "Tickets Discord",
        "title": "Bot ticket Discord avec dashboard et transcripts · Kotbo",
        "description": "Des tickets Discord gérés depuis un dashboard : types de demandes, formulaire, prise en charge, réponses enregistrées, transcripts, archives et note de satisfaction.",
        "h1": "Un bot ticket Discord que ton staff gère depuis un dashboard",
        "lead": "Les membres ouvrent un ticket depuis Discord. Ton staff les traite depuis une boîte de réception, sans perdre le fil entre dix salons.",
        "sections": [
          {
            "h2": "Avant l'ouverture",
            "body": "Le ticket arrive déjà trié :",
            "points": [
              "Plusieurs types de tickets (support, signalement, partenariat...), chacun avec ses réglages",
              "Un formulaire pour que le membre décrive sa demande dès le départ",
              "Validation par le staff avant la création du salon, si tu le souhaites",
              "Liste noire pour les membres qui abusent"
            ]
          },
          {
            "h2": "Pendant",
            "body": "Le staff sait qui s'en occupe et répond vite :",
            "points": [
              "Prise en charge par un membre du staff, visible de tous",
              "Réponses enregistrées pour les questions qui reviennent",
              "Boîte de réception dans le dashboard, avec la fiche du membre à côté"
            ]
          },
          {
            "h2": "Après",
            "body": "Rien ne se perd :",
            "points": [
              "Transcript de la conversation, consultable dans le dashboard",
              "Archives : le salon reste en lecture seule et peut être rouvert",
              "Note de satisfaction demandée au membre",
              "Statistiques de traitement par membre du staff"
            ]
          }
        ],
        "faq": [
          {
            "q": "Comment faire un système de tickets sur Discord ?",
            "a": "Il faut un bot : Discord n'a pas de tickets natifs. Avec Kotbo, tu choisis depuis le dashboard le salon où poster le bouton d'ouverture, les types de demandes et le staff concerné ; le bot ouvre un salon privé pour chaque ticket."
          },
          {
            "q": "Kotbo remplace-t-il Ticket Tool ?",
            "a": "Oui pour les tickets, et il gère aussi la modération, les logs et le staff dans le même dashboard."
          }
        ]
      },
      "en": {
        "name": "Discord tickets",
        "title": "Discord ticket bot with a dashboard · Kotbo",
        "description": "Discord tickets handled from a dashboard: request types, intake form, claiming, saved replies, transcripts, archives and satisfaction ratings.",
        "h1": "A Discord ticket bot your staff runs from a dashboard",
        "lead": "Members open a ticket from Discord. Your staff works through them from an inbox, without losing track across ten channels.",
        "sections": [
          {
            "h2": "Before it opens",
            "body": "Tickets arrive already sorted:",
            "points": [
              "Several ticket types (support, report, partnership...), each with its own settings",
              "An intake form so the member explains the request up front",
              "Staff approval before the channel is created, if you want it",
              "A blacklist for members who abuse it"
            ]
          },
          {
            "h2": "While it runs",
            "body": "Staff knows who has it and answers fast:",
            "points": [
              "Claimed by one staff member, visible to all",
              "Saved replies for questions that keep coming back",
              "A dashboard inbox, with the member's profile alongside"
            ]
          },
          {
            "h2": "After",
            "body": "Nothing gets lost:",
            "points": [
              "A transcript of the conversation, viewable in the dashboard",
              "Archives: the channel stays read-only and can be reopened",
              "A satisfaction rating asked from the member",
              "Handling stats per staff member"
            ]
          }
        ],
        "faq": [
          {
            "q": "How do I set up a ticket system on Discord?",
            "a": "You need a bot: Discord has no native tickets. With Kotbo, you pick from the dashboard the channel for the open button, the request types and the staff in charge; the bot opens a private channel for each ticket."
          },
          {
            "q": "Does Kotbo replace Ticket Tool?",
            "a": "For tickets, yes, and it also handles moderation, logs and staff in the same dashboard."
          }
        ]
      }
    }
  },
  {
    "key": "leveling",
    "slug": {
      "fr": "niveaux-xp",
      "en": "leveling-xp"
    },
    "modules": [
      "Leveling & XP",
      "Saisons",
      "Seasons"
    ],
    "position": 4,
    "content": {
      "fr": {
        "name": "Niveaux et XP",
        "title": "Bot Discord de niveaux et d'XP avec carte de rang · Kotbo",
        "description": "Un bot Discord de niveaux : XP pour les messages et le vocal, rôles de récompense, classements automatiques, saisons et carte de rang personnalisable.",
        "h1": "Un bot Discord de niveaux qui récompense l'activité réelle",
        "lead": "Les membres gagnent de l'XP en écrivant et en parlant en vocal. Kotbo écarte ce qui ne compte pas, et transforme les niveaux en rôles, en classements et en saisons.",
        "sections": [
          {
            "h2": "De l'XP qui ne se farme pas",
            "body": "Tu règles ce qui rapporte, et ce qui ne rapporte rien :",
            "points": [
              "Délai entre deux gains d'XP, pour que le spam ne paie pas",
              "Bonus pour les messages longs, plafonné",
              "XP en vocal, seulement micro et son ouverts, hors salon AFK, à partir du nombre de membres choisi",
              "Salons et rôles exclus, multiplicateurs pour ceux que tu veux mettre en avant"
            ]
          },
          {
            "h2": "Des niveaux qui débloquent quelque chose",
            "body": "Chaque palier peut donner un rôle, cumulable ou non avec les précédents. Des classements se publient tout seuls (messages, vocal ou XP), et les saisons remettent les compteurs à zéro en gardant les palmarès."
          },
          {
            "h2": "La carte de rang, à leur image",
            "body": "Chaque membre personnalise sa carte de rang (fond, couleurs, succès débloqués). Tu peux l'essayer sur l'accueil de ce site."
          }
        ],
        "faq": [
          {
            "q": "Comment mettre un système de niveaux sur Discord ?",
            "a": "Discord n'en a pas : il faut un bot. Avec Kotbo, tu actives le module Leveling depuis le dashboard, tu fixes les gains d'XP et les rôles de récompense, et les membres voient leur progression avec la commande de rang."
          },
          {
            "q": "Kotbo est-il une alternative à MEE6 pour les niveaux ?",
            "a": "Oui : XP pour les messages et le vocal, rôles de récompense, classements et carte de rang, avec en plus les saisons. Et le même bot gère la modération, les tickets et les logs."
          }
        ]
      },
      "en": {
        "name": "Levels and XP",
        "title": "Discord leveling bot with XP and rank cards · Kotbo",
        "description": "A Discord leveling bot: XP for messages and voice, reward roles, automatic leaderboards, seasons and a customizable rank card.",
        "h1": "A Discord leveling bot that rewards real activity",
        "lead": "Members earn XP by chatting and talking in voice. Kotbo filters out what shouldn't count, and turns levels into roles, leaderboards and seasons.",
        "sections": [
          {
            "h2": "XP that can't be farmed",
            "body": "You decide what earns XP, and what doesn't:",
            "points": [
              "A cooldown between XP gains, so spam never pays",
              "A capped bonus for longer messages",
              "Voice XP only while unmuted and undeafened, outside the AFK channel, from the member count you choose",
              "Excluded channels and roles, multipliers for the ones you want to highlight"
            ]
          },
          {
            "h2": "Levels that unlock something",
            "body": "Each level can grant a role, stacking with earlier ones or not. Leaderboards post themselves (messages, voice or XP), and seasons reset the counters while keeping the hall of fame."
          },
          {
            "h2": "A rank card that looks like them",
            "body": "Every member customizes their rank card (background, colors, unlocked achievements). You can try it on this site's home page."
          }
        ],
        "faq": [
          {
            "q": "How do I add a leveling system to Discord?",
            "a": "Discord doesn't have one: you need a bot. With Kotbo, turn on the Leveling module from the dashboard, set XP gains and reward roles, and members follow their progress with the rank command."
          },
          {
            "q": "Is Kotbo an alternative to MEE6 for levels?",
            "a": "Yes: XP for messages and voice, reward roles, leaderboards and rank cards, plus seasons. And the same bot handles moderation, tickets and logs."
          }
        ]
      }
    }
  }
]
;
