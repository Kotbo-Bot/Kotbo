/**
 * Droit requis par chaque bloc de la page d'accueil.
 *
 * La grille Bento monte des blocs qui rejouent le contenu d'autres sections :
 * un compte a qui l'on retire « Tickets » ou « Membres » dans le centre de
 * gestion pouvait remettre la meme donnee sous les yeux en ajoutant le bloc
 * correspondant. La table vit ici parce que le dashboard doit masquer le bloc
 * et l'API refuser la section : les deux cotes doivent lire la meme regle.
 */
export type HomeWidgetAccess = {
  /** Clef de fonctionnalite du centre de gestion, si le bloc en depend. */
  feature?: string;
  /** Bloc qui ecrit un reglage du serveur : reserve a qui peut configurer. */
  adminOnly?: boolean;
};

export const HOME_WIDGET_ACCESS: Record<string, HomeWidgetAccess> = {
  analytics: { feature: 'analytics' },
  liveStats: { feature: 'analytics' },
  channels: { feature: 'analytics' },
  moderation: { feature: 'sanctions' },
  members: { feature: 'members' },
  notifications: { feature: 'inbox' },
  staff: { feature: 'staff_directory' },
  audit: { feature: 'logs' },
  botLanguage: { adminOnly: true },
  timezone: { adminOnly: true },
  news: { feature: 'news' },
  economy: { feature: 'economy' },
  leveling: { feature: 'leveling' },
  tickets: { feature: 'tickets' },
  invites: { feature: 'members' },
  events: { feature: 'events' },
  polls: { feature: 'polls' },
  staffServer: { feature: 'staff_server' },
  pulse: { feature: 'analytics' },
  shield: { feature: 'raid_protection' },
  myTasks: { feature: 'doing_lists' },
  boosts: { feature: 'members' },
  climate: { feature: 'analytics' },
};

export function homeWidgetFeatureKey(widgetId: string): string | undefined {
  return HOME_WIDGET_ACCESS[widgetId]?.feature;
}

export function isHomeWidgetAdminOnly(widgetId: string): boolean {
  return HOME_WIDGET_ACCESS[widgetId]?.adminOnly === true;
}
