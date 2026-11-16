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
    const config = traefikDynamicConfig([{ host: 'panel.monserveur.fr' }], env) as { http: { routers: Record<string, { rule: string; tls?: unknown }> } };
    const routers = config.http.routers;
    expect(Object.keys(routers)).toHaveLength(3);
    expect(routers['kotbo-cd-panel-monserveur-fr-api'].rule).toBe('Host(`panel.monserveur.fr`) && PathPrefix(`/api`)');
    expect(routers['kotbo-cd-panel-monserveur-fr'].tls).toEqual({ certResolver: 'letsencrypt' });
  });

  test("avec Cloudflare for SaaS, Traefik n'ouvre pas de défi Let's Encrypt", () => {
    const env = {
      CUSTOM_DOMAIN_API_UPSTREAM: 'http://bot:8787',
      CUSTOM_DOMAIN_DASHBOARD_UPSTREAM: 'http://dash:80',
      CLOUDFLARE_API_TOKEN: 'x',
      CLOUDFLARE_ZONE_ID: 'y',
    };
    const config = traefikDynamicConfig([{ host: 'panel.monserveur.fr' }], env) as { http: { routers: Record<string, { tls?: unknown }> } };
    expect(config.http.routers['kotbo-cd-panel-monserveur-fr'].tls).toEqual({});
  });

  test("un serveur servi par son bot envoie /api vers le port de son instance", () => {
    const env = { CUSTOM_DOMAIN_API_UPSTREAM: 'http://bot:8787', CUSTOM_DOMAIN_DASHBOARD_UPSTREAM: 'http://dash:80' };
    const config = traefikDynamicConfig([{ host: 'panel.monserveur.fr', apiPort: 8790 }], env) as {
      http: { routers: Record<string, { service: string }>; services: Record<string, { loadBalancer: { servers: Array<{ url: string }> } }> };
    };
    expect(config.http.routers['kotbo-cd-panel-monserveur-fr-api'].service).toBe('kotbo-cd-api-8790');
    expect(config.http.services['kotbo-cd-api-8790'].loadBalancer.servers[0].url).toBe('http://bot:8790');
  });

  test('sans amont configuré, Traefik ne reçoit aucun routeur', () => {
    expect(traefikDynamicConfig([{ host: 'panel.monserveur.fr' }], {})).toEqual({ http: {} });
  });
});
