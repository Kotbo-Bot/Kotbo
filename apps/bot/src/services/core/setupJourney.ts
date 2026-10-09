/**
 * Parcours de configuration : ce qui est en place, ce qui manque, et ou aller.
 *
 * Kotbo a une centaine de reglages repartis sur autant de pages. Un serveur qui
 * vient de l'activer n'a aucun moyen de savoir par ou commencer, ni de verifier
 * qu'il n'a rien oublie d'essentiel. Ce calcul repond aux deux questions en
 * lisant la configuration reelle plutot qu'en tenant un compteur d'etapes
 * franchies - un reglage efface doit redevenir « a faire ».
 *
 * Deux lecteurs : la page « Prise en main », qui montre tout le parcours, et
 * l'accueil, qui n'en garde que les trous.
 */
import prisma from '../../utils/db.js';

export type SetupStep = {
  key: string;
  /** Regroupement affiche : l'ordre des groupes est l'ordre conseille. */
  group: 'essentiel' | 'moderation' | 'engagement';
  label: string;
  /** Ce que le serveur y gagne. Sans cela, une case a cocher n'est qu'une corvee. */
  why: string;
  done: boolean;
  /** Page ou regler le point. */
  href: string;
  /** Ce qui manque precisement, quand ce n'est pas evident. */
  detail?: string;
};

export type SetupJourney = {
  steps: SetupStep[];
  progress: { done: number; total: number };
};

/** Vrai si la chaine porte une valeur exploitable. */
function filled(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** `null` quand le serveur n'existe pas en base. */
export async function computeSetupJourney(guildId: string): Promise<SetupJourney | null> {
  const [guild, features, welcome] = await Promise.all([
    prisma.guild.findUnique({
      where: { id: guildId },
      select: {
        logChannelId: true,
        moderatorRoleId: true,
        regulationChannelId: true,
        timezone: true,
        language: true,
        ticketCategoryId: true,
        ticketStaffRoleId: true,
        ticketChannelId: true,
        sanctionAlertChannelId: true,
        ticketQuotaOpenEnabled: true,
      },
    }),
    prisma.dashboardFeatureConfig.findMany({
      where: { guildId },
      select: { featureKey: true, enabled: true },
    }),
    prisma.welcomeConfig.findUnique({
      where: { guildId },
      select: { welcomeEnabled: true, welcomeChannelId: true },
    }),
  ]);

  if (!guild) return null;

  // Un module sans ligne de configuration est actif : c'est la convention du
  // reste du code, un serveur neuf ne doit pas apparaitre tout eteint.
  const enabled = (key: string) => features.find((f) => f.featureKey === key)?.enabled ?? true;

  const steps: SetupStep[] = [
    {
      key: 'logs',
      group: 'essentiel',
      label: 'Salon de logs',
      why: "Sans lui, aucune trace de ce que fait le bot ni de ce qui se passe sur le serveur.",
      done: filled(guild.logChannelId),
      // L'onglet de reglage, pas le journal : le lien menait a une liste de
      // logs vide, et le champ a remplir restait a chercher.
      href: '/logs/config',
    },
    {
      key: 'moderator-role',
      group: 'essentiel',
      label: 'Rôle modérateur',
      why: "Il décide qui peut sanctionner et prendre en charge un ticket. Sans lui, seuls les administrateurs le peuvent.",
      done: filled(guild.moderatorRoleId),
      href: '/security/sanctions/settings',
    },
    {
      key: 'timezone',
      group: 'essentiel',
      label: 'Fuseau horaire',
      why: "Le bot tourne en UTC : sans fuseau, toute date affichée ou saisie est décalée.",
      // `timezone` a une valeur par defaut : le point est fait, il est
      // rappele pour que personne ne decouvre le decalage apres coup.
      done: filled(guild.timezone),
      // `/settings` n'est pas une page du dashboard : le lien tombait dans le
      // vide. Le fuseau se regle dans « Reglages du serveur ».
      href: '/management',
      detail: guild.timezone ?? undefined,
    },
    {
      key: 'regulation',
      group: 'moderation',
      label: 'Règlement publié',
      why: "Une sanction sans règle écrite se conteste. Le règlement sert aussi de référence aux rapports.",
      done: filled(guild.regulationChannelId),
      href: '/regulation',
    },
    {
      key: 'security',
      group: 'moderation',
      label: 'Protection activée',
      why: "Filtres AutoMod et anti-raid. Un niveau de protection les règle tous d'un coup.",
      done: enabled('automod') && enabled('raid_protection'),
      href: '/security/quick-setup',
    },
    {
      key: 'sanction-alerts',
      group: 'moderation',
      label: 'Salon des alertes de sanction',
      why: "Le staff voit passer les sanctions au lieu de les découvrir dans le casier.",
      done: filled(guild.sanctionAlertChannelId),
      href: '/security/sanctions/settings',
    },
    {
      key: 'tickets',
      group: 'engagement',
      label: 'Tickets opérationnels',
      why: "Catégorie, rôle du staff et salon du panneau : sans les trois, un membre ne peut pas ouvrir de ticket.",
      done: enabled('tickets')
        && filled(guild.ticketCategoryId)
        && filled(guild.ticketStaffRoleId)
        && filled(guild.ticketChannelId),
      href: '/tickets/config',
      detail: [
        filled(guild.ticketCategoryId) ? null : 'catégorie',
        filled(guild.ticketStaffRoleId) ? null : 'rôle du staff',
        filled(guild.ticketChannelId) ? null : 'salon du panneau',
      ].filter(Boolean).join(', ') || undefined,
    },
    {
      key: 'ticket-quotas',
      group: 'engagement',
      label: 'Quotas de tickets',
      why: "Sans quota, rien n'empêche un membre d'ouvrir dix tickets d'affilée.",
      done: guild.ticketQuotaOpenEnabled,
      href: '/tickets/config',
    },
    {
      key: 'welcome',
      group: 'engagement',
      label: 'Accueil des arrivants',
      why: "Un serveur qui n'accueille pas perd la moitié de ses arrivants dans la première heure.",
      // Le message d'accueil part du salon de `WelcomeConfig`, que la page
      // regle. `Guild.publicChannelId` sert aux annonces : le lire ici laissait
      // l'etape a faire alors que l'accueil tournait deja.
      done: enabled('welcome_goodbye')
        && welcome?.welcomeEnabled === true
        && filled(welcome.welcomeChannelId),
      // `/welcome-goodbye` n'a jamais ete une route du dashboard : le lien
      // tombait sur la page introuvable.
      href: '/announcement/welcome',
    },
  ];

  return {
    steps,
    progress: { done: steps.filter((s) => s.done).length, total: steps.length },
  };
}
