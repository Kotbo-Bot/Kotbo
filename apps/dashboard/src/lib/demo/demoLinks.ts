/**
 * Liens de la demo servie sous kotbo.fr/demo.
 *
 * Les liens du dashboard sont ecrits depuis la racine (`/members`). Tinro les
 * intercepte au clic et ajoute lui-meme la base, mais le navigateur, lui, ne
 * la connait pas : ouvrir un lien dans un nouvel onglet ou copier son adresse
 * menait a kotbo.fr/members, une page 404.
 *
 * Le `href` porte donc la base pour le navigateur, et la perd le temps d'un
 * clic simple : tinro lit l'attribut brut et pousserait sinon /demo/demo/...
 */
export function withBase(href: string, base: string): string | null {
  if (!href.startsWith('/') || href.startsWith('//')) return null;
  if (href === base || href.startsWith(`${base}/`)) return null;
  return base + href;
}

export function installDemoLinks(base: string, root: Document = document): () => void {
  const view = root.defaultView ?? window;
  // Liens dont le prefixe est retire le temps qu'un clic soit traite.
  const stripped = new WeakSet<Element>();

  function prefix(anchor: Element) {
    if (stripped.has(anchor)) return;
    const next = withBase(anchor.getAttribute('href') ?? '', base);
    if (next) anchor.setAttribute('href', next);
  }

  function prefixWithin(node: Node) {
    if (!(node instanceof view.Element)) return;
    if (node.matches('a[href]')) prefix(node);
    node.querySelectorAll('a[href]').forEach(prefix);
  }

  prefixWithin(root.documentElement);

  const observer = new view.MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') prefixWithin(record.target);
      else record.addedNodes.forEach(prefixWithin);
    }
  });
  observer.observe(root.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['href'] });

  // Phase de capture : passe avant l'ecouteur de tinro, pose sur window en
  // phase de remontee. Les clics que tinro laisse au navigateur (touche de
  // modification, autre bouton, autre cible) gardent le lien prefixe.
  function onClick(event: MouseEvent) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const anchor = (event.target as Element | null)?.closest?.('a[href]');
    if (!anchor || (anchor.getAttribute('target') ?? '_self') !== '_self') return;
    const href = anchor.getAttribute('href') ?? '';
    if (!href.startsWith(`${base}/`)) return;

    stripped.add(anchor);
    anchor.setAttribute('href', href.slice(base.length));
    view.setTimeout(() => {
      stripped.delete(anchor);
      prefix(anchor);
    }, 0);
  }
  view.addEventListener('click', onClick, true);

  return () => {
    observer.disconnect();
    view.removeEventListener('click', onClick, true);
  };
}
