import { describe, expect, test } from 'bun:test';
import { generateRssXml } from '../../services/core/newsService';

describe('news RSS generator', () => {
  test("génère un document XML RSS 2.0 valide à partir d'articles", () => {
    const guildName = 'Serveur Test';
    const guildId = '123456789';
    const dashboardUrl = 'https://dashboard.example.com';
    const apiUrl = 'https://api.example.com';
    
    const articles = [
      {
        id: 'art-1',
        title: 'Mise à jour v1.0.0',
        content: 'Contenu détaillé de la mise à jour.',
        summary: 'Résumé court de la mise à jour.',
        imageUrl: 'https://example.com/image.png',
        authorName: 'Elouan',
        category: 'Mise à jour',
        publishedAt: new Date('2026-05-25T12:00:00Z'),
      },
      {
        id: 'art-2',
        title: 'Bilan de sécurité',
        content: 'Rapport de sécurité complet.',
        summary: null,
        imageUrl: null,
        authorName: 'Staff Admin',
        category: 'Annonce',
        publishedAt: new Date('2026-05-24T12:00:00Z'),
      }
    ];

    const xml = generateRssXml(guildName, guildId, dashboardUrl, apiUrl, articles);

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8" ?>');
    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain(`<title><![CDATA[Actualités - ${guildName}]]></title>`);
    expect(xml).toContain(`<link>${dashboardUrl}/${guildId}/news</link>`);
    expect(xml).toContain(`<atom:link href="${apiUrl}/api/public/rss/${guildId}"`);
    
    // Check article 1 (with image & summary)
    expect(xml).toContain('<title><![CDATA[Mise à jour v1.0.0]]></title>');
    expect(xml).toContain('<author><![CDATA[Elouan]]></author>');
    expect(xml).toContain('<category><![CDATA[Mise à jour]]></category>');
    expect(xml).toContain('<description><![CDATA[Résumé court de la mise à jour.]]></description>');
    expect(xml).toContain('<media:content url="https://example.com/image.png" medium="image" />');

    // Check article 2 (without image, content falls back to description)
    expect(xml).toContain('<title><![CDATA[Bilan de sécurité]]></title>');
    expect(xml).toContain('<author><![CDATA[Staff Admin]]></author>');
    expect(xml).toContain('<category><![CDATA[Annonce]]></category>');
    expect(xml).toContain('<description><![CDATA[Rapport de sécurité complet.]]></description>');
    
    const items = xml.split('<item>');
    expect(items[2]).not.toContain('media:content');
  });

  test("génère un canal vide si aucun article n'est passé", () => {
    const xml = generateRssXml('Serveur Vide', '000', 'https://dash.com', 'https://api.com', []);
    expect(xml).toContain('<channel>');
    expect(xml).not.toContain('<item>');
  });

  test('génère le bon lien atom:link avec filtrage par catégorie et sous-catégorie', () => {
    const guildName = 'Serveur Filtré';
    const guildId = '987654321';
    const dashboardUrl = 'https://dash.com';
    const apiUrl = 'https://api.com';

    // Test with only category
    const xmlCat = generateRssXml(guildName, guildId, dashboardUrl, apiUrl, [], 'Changelog');
    expect(xmlCat).toContain(`<atom:link href="${apiUrl}/api/public/rss/${guildId}/Changelog" rel="self" type="application/rss+xml" />`);

    // Test with category and subcategory
    const xmlSub = generateRssXml(guildName, guildId, dashboardUrl, apiUrl, [], 'Changelog', 'API');
    expect(xmlSub).toContain(`<atom:link href="${apiUrl}/api/public/rss/${guildId}/Changelog/API" rel="self" type="application/rss+xml" />`);
  });
});
