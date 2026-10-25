/**
 * Types de la mise en place, sans dependance d execution : le parcours et ses
 * tests les lisent sans charger le client API ni les stores Svelte.
 */

export type ServerTemplateSection =
  | 'access' | 'security' | 'staff' | 'captcha' | 'tickets' | 'welcome' | 'stats' | 'text' | 'fun' | 'bots' | 'voice' | 'modules';
export type ServerTemplateWiring =
  | 'staff' | 'logs' | 'tickets' | 'leveling' | 'rpg' | 'tempvoice' | 'welcome' | 'rules' | 'member' | 'captcha' | 'honeypot' | 'starboard' | 'stats' | 'autothread' | null;
/** A qui le salon s'ouvre : tout le plan etant ferme a @everyone, c'est ce qui les distingue. */
export type ServerTemplateAudience = 'staff' | 'member' | 'pending' | 'everyone';

export type ServerTemplatePlanItem = {
  key: string;
  section: ServerTemplateSection;
  kind: 'role' | 'category' | 'text' | 'voice' | 'module';
  parent: string | null;
  name: string;
  wiring: ServerTemplateWiring;
  audience: ServerTemplateAudience;
  readOnly: boolean;
  required: boolean;
  /** Module du dashboard active par cet element. */
  moduleId: string | null;
  /** Salon dont la creation coche ce module. */
  linkedTo: string | null;
  /** Element sans lequel celui-ci ne fonctionne pas : le cocher le ramene. */
  dependsOn: string | null;
};

export type ServerTemplateState = {
  locale: 'fr' | 'en';
  plan: ServerTemplatePlanItem[];
  /**
   * Clefs de la maquette que le serveur porte deja.
   *
   * Rapprochees cote bot par identifiant enregistre, puis par nom normalise.
   * Vide sur un serveur neuf ; sur un serveur habite, c'est ce qui permet a la
   * reprise de completer au lieu de doubler `#reglement` et `#bienvenue`.
   */
  present: string[];
  /**
   * Le meme constat, avec ce qui l'a produit.
   *
   * `present` dit qu'un element est deja la ; il ne dit pas lequel, et c'est ce
   * qui manquait pour poser la question. Ici chaque clef du plan pointe le
   * salon ou le role reconnu, et dit si le rapprochement est certain - un
   * identifiant que Kotbo avait enregistre - ou devine sur la ressemblance du
   * nom. Les ecrans de mappage pre-remplissent avec, et laissent corriger : un
   * `#logs-mod` que la ressemblance n'attrape pas se designe a la main plutot
   * que de se faire doubler.
   */
  matches: Record<string, { id: string; name: string; source: 'ref' | 'name' }>;
  /**
   * Les salons et roles reels du serveur, matiere des menus « utiliser
   * l'existant ». Bornee cote bot : au-dela de quelques centaines d'entrees, un
   * menu deroulant n'est plus l'outil.
   */
  inventory: {
    channels: { id: string; name: string; kind: 'text' | 'voice' | 'category'; parentId: string | null; position: number }[];
    roles: { id: string; name: string; color: string; position: number; assignable: boolean; managed: boolean }[];
  };
  /**
   * Les salons que Discord a poses lui-meme a la creation du serveur, par
   * clef du plan.
   *
   * Un serveur tout neuf n'est jamais vide : deux categories et deux salons
   * y sont poses d'office, sous les noms memes de la maquette. Les ignorer
   * revenait a en creer des jumeaux et a faire passer pour habite un serveur
   * cree la minute d'avant. La pose s'y branche donc au lieu de doubler, et
   * ils ne declenchent pas le parcours detaille.
   */
  defaults: Record<string, { id: string; name: string }>;
  /**
   * Le serveur porte deja quelque chose qui lui est propre.
   *
   * Lu sur les faits - un element du plan reconnu, ou des salons en nombre que
   * Kotbo n'a pas poses - et non sur la reponse a l'ecran « neuf ou existant ».
   * C'est ce qui fait basculer le parcours en mode detaille, ou l'on dit quel
   * salon est quoi section par section, au lieu de tout poser d'un bloc.
   */
  structured: boolean;
  defaultSelection: string[];
  missingPermissions: string[];
  canCreateChannels: boolean;
  /** Un salon de logs est deja configure : la sante des salons a ou parler. */
  hasLogChannel: boolean;
  isAdministrator: boolean;
  /**
   * Serveur neuf a batir, ou serveur habite a reprendre. Lu sur les faits (age,
   * membres, salons, roles) et non demande a l'administrateur : il repond
   * « nouveau serveur » parce que Kotbo est nouveau pour lui, pas parce que le
   * serveur l'est.
   */
  maturity: {
    maturity: 'fresh' | 'established';
    ageDays: number;
    /** Ce qui a fait pencher la balance, affiche tel quel. */
    reasons: string[];
  };
  /**
   * Maquette complete. Sur un serveur habite, `defaultSelection` n'en retient
   * que les modules : ce champ permet de proposer quand meme tout cocher, sans
   * que la page ait a reconstruire la liste.
   */
  fullSelection: string[];
  applied: { at: string; by: string | null; selection: string[] } | null;
};

/** Ce qu'un rôle créé par le parcours peut faire, en échelons fermés côté bot. */
export type StaffRolePower = 'admin' | 'manage' | 'moderate' | 'coordinate' | 'assist' | 'none';
