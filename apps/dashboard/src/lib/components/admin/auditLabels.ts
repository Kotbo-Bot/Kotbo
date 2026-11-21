/**
 * Libellés lisibles du journal d'audit admin.
 *
 * Les actions sont stockées sous la forme `domaine.verbe` ; on les traduit ici
 * pour ne jamais montrer un code technique à qui lit le journal.
 */

export const AUDIT_DOMAINS: Record<string, string> = {
  broadcast: 'Annonces',
  guild: 'Serveurs',
  shard: 'Bot',
  admin: 'Administrateurs',
  blacklist: 'Blacklist',
  whitelabel: 'Bots personnalisés',
  gdpr: 'RGPD',
  site: 'Sites communautaires',
  banned_word: 'Mots interdits',
  activation_code: 'Codes d’activation',
  achievement: 'Succès',
  feature_page: 'Pages fonctionnalités',
  instance: 'Instances',
  maintenance: 'Maintenance',
  errors: 'Erreurs',
  query_stats: 'Performances',
  staff_server: 'Serveur staff',
  dashboard: 'Dashboard',
};

export const AUDIT_ACTIONS: Record<string, string> = {
  'site.report_status': 'Signalement de site traité',
  'site.suspend': 'Site suspendu',
  'site.unsuspend': 'Site réactivé',
  'dashboard.global_admin_write': 'Modification faite en tant qu’admin global',
  'query_stats.reset': 'Statistiques de requêtes remises à zéro',
  'shard.restart_all': 'Redémarrage complet du bot',
  'shard.restart': 'Redémarrage d’un shard',
  'guild.invite': 'Invitation créée',
  'guild.leave': 'Départ forcé d’un serveur',
  'admin.grant': 'Accès admin accordé',
  'admin.revoke': 'Accès admin retiré',
  'blacklist.add': 'Utilisateur blacklisté',
  'blacklist.remove': 'Utilisateur retiré de la blacklist',
  'banned_word.upsert': 'Mots interdits ajoutés',
  'banned_word.cleanup': 'Mots interdits dédoublonnés',
  'banned_word.update': 'Mot interdit modifié',
  'banned_word.delete': 'Mot interdit supprimé',
  'maintenance.enable': 'Maintenance activée',
  'maintenance.disable': 'Maintenance désactivée',
  'errors.purge': 'Erreurs purgées',
  'broadcast.media.upload': 'Média d’annonce envoyé',
  'broadcast.media.delete': 'Média d’annonce supprimé',
  'broadcast.cancel': 'Annonce annulée',
  'broadcast.schedule': 'Annonce programmée',
  'broadcast.send': 'Annonce envoyée',
  'guild.plan.set': 'Offre du serveur modifiée',
  'guild.billing.gift': 'Abonnement offert',
  'guild.billing.detach': 'Abonnement détaché',
  'guild.billing.trial_reset': 'Essai réinitialisé',
  'guild.billing.transfer': 'Abonnement transféré',
  'guild.billing.resync': 'Abonnement resynchronisé',
  'activation_code.create': 'Code d’activation créé',
  'activation_code.revoke': 'Code d’activation révoqué',
  'staff_server.reconcile': 'Serveur staff réconcilié',
  'guild.deactivate': 'Serveur désactivé',
  'guild.activate': 'Serveur activé',
  'guild.access_extend': 'Accès du serveur prolongé',
  'guild.rescan_stats': 'Statistiques du serveur recalculées',
  'guild.resync_all': 'Resynchronisation de tous les serveurs',
  'guild.reset_template': 'Modèle du serveur réinitialisé',
  'guild.onboarding.skip': 'Onboarding passé',
  'guild.rescan_members': 'Membres du serveur rescannés',
  'whitelabel.create': 'Bot personnalisé créé',
  'whitelabel.update': 'Bot personnalisé modifié',
  'whitelabel.delete': 'Bot personnalisé supprimé',
  'whitelabel.bind_guild': 'Serveur rattaché à un bot personnalisé',
  'whitelabel.unbind_guild': 'Serveur détaché d’un bot personnalisé',
  'instance.ban': 'Instance bannie',
  'instance.unban': 'Instance débannie',
  'instance.authorize': 'Instance autorisée',
  'instance.revoke': 'Autorisation d\'instance révoquée',
  'gdpr.delete_reviews': 'Avis supprimés (RGPD)',
  'gdpr.preview': 'Aperçu d’export RGPD',
  'gdpr.export': 'Export RGPD généré',
  'achievement.grant': 'Succès attribué',
  'achievement.revoke': 'Succès retiré',
  'feature_page.create': 'Page fonctionnalité créée',
  'feature_page.import': 'Pages fonctionnalités importées',
  'feature_page.update': 'Page fonctionnalité modifiée',
  'feature_page.delete': 'Page fonctionnalité supprimée',
};

export const AUDIT_TARGET_TYPES: Record<string, string> = {
  guild: 'Serveur',
  user: 'Utilisateur',
  shard: 'Shard',
  container: 'Conteneur',
  broadcast: 'Annonce',
  broadcast_media: 'Média d’annonce',
  banned_word: 'Mot interdit',
};

const humanize = (code: string) => {
  const text = code.replace(/[._]/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

export const auditDomain = (action: string) => {
  const domain = action.split('.')[0];
  return AUDIT_DOMAINS[domain] ?? humanize(domain);
};

export const auditActionLabel = (action: string) => AUDIT_ACTIONS[action] ?? humanize(action);

export const auditTargetType = (type: string | null | undefined) =>
  type ? (AUDIT_TARGET_TYPES[type] ?? humanize(type)) : null;
