/**
 * Formulaires : trois formulaires du serveur, leurs réponses, un panneau de
 * recrutement et la page publique `/form/:id`, servie elle aussi par la démo
 * (le lien « Copier » mène donc à un vrai formulaire à remplir).
 */
import { route } from '../backend';
import { demoDb, demoId } from '../db';
import { row } from '../model';
import { G } from '../crud';
import { DAY, PEOPLE, ago, channelByName } from '../fixtures';
import { DEMO_GUILD_ID } from '../mode';

const field = (id: string, type: string, label: string, extra: Record<string, unknown> = {}) => ({ id, type, label, required: true, sectionIndex: 0, ...extra });

function formsSeed() {
  const form = (id: string, name: string, description: string, structure: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    ...row('CustomForm', { id, guildId: DEMO_GUILD_ID, name, description, structure, createdAt: ago(20 * DAY), updatedAt: ago(2 * DAY) }),
    hierarchy: null,
    ...extra,
  });
  return [
    form('form-tournoi', 'Inscription au tournoi', 'Inscris ton équipe au tournoi d’automne.', {
      title: 'Tournoi d’automne · inscription',
      description: 'Équipes de 3. Inscriptions jusqu’au 30 novembre.',
      headerColor: '#22d3ee',
      sections: [{ id: 's0', title: 'Ton équipe', description: '' }],
      fields: [
        field('team', 'short_text', 'Nom de l’équipe', { placeholder: 'Les Licornes' }),
        field('captain', 'short_text', 'Pseudo Discord du capitaine'),
        field('mates', 'paragraph', 'Pseudos des deux coéquipiers'),
        field('rank', 'dropdown', 'Rang moyen de l’équipe', { options: ['Fer – Bronze', 'Argent – Or', 'Platine – Diamant', 'Immortel et +'] }),
        field('dispo', 'checkboxes', 'Soirs disponibles', { options: ['Lundi', 'Mercredi', 'Vendredi', 'Samedi'], required: false }),
      ],
    }, { _count: { submissions: 12, events: 1 } }),
    form('form-recrutement', 'Candidature modérateur', 'Rejoins l’équipe de modération.', {
      title: 'Devenir modérateur',
      description: 'Réponds sincèrement : le staff lit chaque candidature.',
      headerColor: '#5865f2',
      sections: [{ id: 's0', title: 'Toi', description: '' }, { id: 's1', title: 'Mises en situation', description: '' }],
      fields: [
        field('age', 'number', 'Ton âge', { validation: { min: 13, max: 99 } }),
        field('time', 'multiple_choice', 'Temps disponible par semaine', { options: ['Moins de 3 h', '3 à 7 h', 'Plus de 7 h'] }),
        field('why', 'paragraph', 'Pourquoi veux-tu rejoindre le staff ?'),
        field('case', 'paragraph', 'Un membre insulte un autre en vocal. Que fais-tu ?', { sectionIndex: 1 }),
        field('scale', 'linear_scale', 'Ton expérience de la modération', { scaleMin: 1, scaleMax: 5, scaleMinLabel: 'Aucune', scaleMaxLabel: 'Beaucoup', sectionIndex: 1 }),
      ],
    }, { isRecruitment: true, requiresDiscordAuth: true, hierarchyId: 'hier-moderation', hierarchy: { id: 'hier-moderation', name: 'Modération', color: '#5865f2', icon: '🛡️' }, _count: { submissions: 4, events: 0 } }),
    form('form-appeal', 'Contestation de sanction', 'Formulaire utilisé par les contestations de ban.', {
      title: 'Contester une sanction',
      description: 'Explique calmement ce qui s’est passé.',
      headerColor: '#f59e0b',
      sections: [{ id: 's0', title: '', description: '' }],
      fields: [field('why', 'paragraph', 'Pourquoi devrions-nous lever ta sanction ?'), field('rules', 'paragraph', 'Qu’as-tu compris du règlement ?')],
    }, { _count: { submissions: 3, events: 0 } }),
  ];
}

const submissionsSeed = () => {
  const people = PEOPLE.filter((p) => !p.bot).slice(5, 12);
  const team = ['Les Licornes', 'Team Zen', 'Les Nouveaux', 'Pixel Squad', 'Night Owls'];
  return [
    ...team.map((name, i) => row('CustomFormSubmission', { id: `sub-t${i}`, formId: 'form-tournoi', guildId: DEMO_GUILD_ID, userId: people[i].id, username: people[i].displayName, userTag: people[i].username, data: { team: name, captain: people[i].username, mates: `${people[i + 1]?.username ?? 'kyzo'}, ${people[i + 2]?.username ?? 'tom'}`, rank: ['Argent – Or', 'Platine – Diamant', 'Fer – Bronze'][i % 3], dispo: ['Vendredi', 'Samedi'] }, createdAt: ago((i + 1) * DAY) })),
    ...people.slice(0, 2).map((p, i) => row('CustomFormSubmission', { id: `sub-r${i}`, formId: 'form-recrutement', guildId: DEMO_GUILD_ID, userId: p.id, username: p.displayName, userTag: p.username, data: { age: 19 + i * 4, time: '3 à 7 h', why: 'J’aime aider et je suis présent tous les soirs.', case: 'Je coupe son micro, je lui parle en privé, puis je fais un rapport.', scale: 3 + i }, createdAt: ago((i + 2) * DAY) })),
  ];
};

const forms = () => demoDb.get('custom-forms', formsSeed);
const submissions = () => demoDb.get('custom-forms/submissions', submissionsSeed);
const withoutStructure = ({ structure, theme, customCss, ...f }: ReturnType<typeof formsSeed>[number]) => f;

export function registerFormRoutes(): void {
  const base = `${G}/custom-forms`;
  route('GET', base, ({ query }) => ({ forms: query.get('includeStructure') === 'true' ? forms() : forms().map(withoutStructure) }));
  route('POST', base, ({ body }) => {
    const form = { ...row('CustomForm', { ...(body ?? {}), id: demoId(), guildId: DEMO_GUILD_ID, structure: body?.structure ?? { title: body?.name ?? 'Nouveau formulaire', fields: [], sections: [{ id: 's0', title: '' }] } }), hierarchy: null, _count: { submissions: 0, events: 0 } };
    demoDb.set('custom-forms', [form, ...forms()]);
    return { form };
  });
  route('GET', `${base}/:formId`, ({ params }) => ({ form: forms().find((f) => f.id === params.formId) ?? null }));
  route('PATCH', `${base}/:formId`, ({ params, body }) => {
    demoDb.set('custom-forms', forms().map((f) => (f.id === params.formId ? { ...f, ...(body ?? {}), updatedAt: new Date().toISOString() } : f)));
    return { ok: true };
  });
  route('DELETE', `${base}/:formId`, ({ params }) => {
    demoDb.set('custom-forms', forms().filter((f) => f.id !== params.formId));
    return { ok: true };
  });
  route('GET', `${base}/:formId/submissions`, ({ params }) => {
    const list = submissions().filter((s) => s.formId === params.formId).map((s) => ({ ...s, avatarUrl: null }));
    return { submissions: list, total: list.length, limit: 100, offset: 0 };
  });

  // Page publique : la démo sert le formulaire et accepte la réponse.
  const publicForm = (formId: string) => {
    const form = forms().find((f) => f.id === formId);
    if (!form) return new Response(JSON.stringify({ error: 'Formulaire introuvable' }), { status: 404 });
    return { id: form.id, name: form.name, description: form.description, guildId: form.guildId, requiresDiscordAuth: false, formType: form.isRecruitment ? 'recruitment' : 'custom', structure: form.structure, theme: null, customCss: null };
  };
  route('GET', '/api/public/forms/:formId', ({ params }) => publicForm(params.formId));
  const submit = ({ params, body }: { params: Record<string, string>; body: any }) => {
    const sub = row('CustomFormSubmission', { id: demoId(), formId: params.formId, guildId: DEMO_GUILD_ID, userId: null, username: 'Visiteur de la démo', data: body?.answers ?? body?.data ?? body ?? {} });
    demoDb.set('custom-forms/submissions', [sub, ...submissions()]);
    return { success: true, id: sub.id };
  };
  route('POST', '/api/public/forms/:formId/submit', submit);
  route('POST', '/api/public/custom-forms/:formId/submit', submit);

  const panels = () => demoDb.get('recruitment/panels', () => [
    row('RecruitmentPanel', { id: 'rp-1', guildId: DEMO_GUILD_ID, channelId: channelByName('annonces').id, messageId: '900000000000009201', title: 'Le staff recrute !', formIds: ['form-recrutement'], createdAt: ago(15 * DAY) }),
  ]);
  route('GET', `${G}/recruitment/panels`, () => ({ panels: panels() }));
  route('POST', `${G}/recruitment/panels`, ({ body }) => {
    const panel = row('RecruitmentPanel', { ...(body ?? {}), id: demoId(), guildId: DEMO_GUILD_ID, messageId: demoId() });
    demoDb.set('recruitment/panels', [...panels(), panel]);
    return { panel };
  });
  route('PATCH', `${G}/recruitment/panels/:panelId`, ({ params, body }) => {
    let panel: unknown;
    demoDb.set('recruitment/panels', panels().map((p) => (p.id === params.panelId ? (panel = { ...p, ...(body ?? {}) }) as typeof p : p)));
    return { panel };
  });
  route('DELETE', `${G}/recruitment/panels/:panelId`, ({ params }) => {
    demoDb.set('recruitment/panels', panels().filter((p) => p.id !== params.panelId));
    return { ok: true };
  });
}
