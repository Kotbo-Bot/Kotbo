import { describe, expect, test } from 'bun:test';
import { customDomainGate, normalizeCustomDomain, traefikDynamicConfig } from '../../services/system/customDomain.js';
import { customBotOnlyGuild } from '../../utils/guildOwnership.js';

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

  describe('cloisonnement sur le domaine perso', () => {
    const own = '123456789012345678';
    const other = '223456789012345678';
    const gate = (path: string) => customDomainGate({ guildId: own }, path);

    test('laisse passer son serveur et les routes de connexion', () => {
      for (const ok of [`/api/dashboard/guilds/${own}/settings`, '/api/dashboard/guilds', '/api/auth/session', '/api/branding', `/api/site-admin/${own}`, '/api/dashboard/ws']) {
        expect(gate(ok)).toBeNull();
      }
    });

    test('refuse tout autre serveur, même encodé ou mêlé à son serveur', () => {
      for (const bad of [`/api/dashboard/guilds/${other}/settings`, `/api/dashboard/guilds/${own}/x/${other}`, `/api/site-admin/${other}`, `/api/dashboard/guilds/%32${other.slice(1)}/x`]) {
        expect(gate(bad)?.status).toBe(403);
      }
    });

    test('ferme admin, facturation, MCP, interne et chemins douteux', () => {
      for (const closed of ['/api/admin/guilds', '/api/billing/checkout', '/api/mcp/x', '/api/internal/custom-domains/traefik', '/api/public/invite', '/api/site-editor/mine', '/api/brandingx/..', '/']) {
        expect(gate(closed)?.status).toBeGreaterThanOrEqual(400);
      }
      expect(gate('/api/dashboard/../admin/guilds')?.status).toBe(400);
      expect(gate('/api/dashboard/%2e%2e/admin')?.status).toBe(400);
      expect(gate('/api/dashboard/%E0%A4%A')?.status).toBe(400);
    });
  });

  test('un bot perso n’est autorisé que sur son serveur', () => {
    expect(customBotOnlyGuild({ slug: 'cb-123456789012345678' })).toBe('123456789012345678');
    expect(customBotOnlyGuild({ slug: 'kotbo' })).toBeNull();
    expect(customBotOnlyGuild({ slug: 'cb-abc' })).toBeNull();
  });

  test('sans amont configuré, Traefik ne reçoit aucun routeur', () => {
    expect(traefikDynamicConfig([{ host: 'panel.monserveur.fr' }], {})).toEqual({ http: {} });
  });
});
