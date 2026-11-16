import { describe, expect, test } from 'bun:test';
import { normalizeCustomDomain, traefikDynamicConfig } from '../../services/system/customDomain.js';

describe('domaine du dashboard perso', () => {
  test("ne garde que le nom d'hôte, en minuscules", () => {
    expect(normalizeCustomDomain(' https://Panel.MonServeur.fr/login?x=1 ')).toBe('panel.monserveur.fr');
    expect(normalizeCustomDomain('panel.monserveur.fr:8443')).toBe('panel.monserveur.fr');
    expect(normalizeCustomDomain('panel.monserveur.fr.')).toBe('panel.monserveur.fr');
  });

  test('refuse les saisies qui ne sont pas des domaines publics', () => {
    for (const bad of ['', 'localhost', 'monserveur', '192.168.1.10', 'dash.kotbo.fr', 'kotbo.fr', 'a b.fr', 'pan`el.fr']) {
      expect(normalizeCustomDomain(bad)).toBeNull();
    }
  });

  test('Traefik reçoit un routeur API, un routeur SPA et une redirection https par domaine', () => {
    const env = { CUSTOM_DOMAIN_API_UPSTREAM: 'http://bot:8787', CUSTOM_DOMAIN_DASHBOARD_UPSTREAM: 'http://dash:80' };
    const config = traefikDynamicConfig(['panel.monserveur.fr'], env) as { http: { routers: Record<string, { rule: string; tls?: unknown }> } };
    const routers = config.http.routers;
    expect(Object.keys(routers)).toHaveLength(3);
    expect(routers['kotbo-cd-panel-monserveur-fr-api'].rule).toBe('Host(`panel.monserveur.fr`) && PathPrefix(`/api`)');
    expect(routers['kotbo-cd-panel-monserveur-fr'].tls).toEqual({ certResolver: 'letsencrypt' });
  });

  test('sans amont configuré, Traefik ne reçoit aucun routeur', () => {
    expect(traefikDynamicConfig(['panel.monserveur.fr'], {})).toEqual({ http: {} });
  });
});
