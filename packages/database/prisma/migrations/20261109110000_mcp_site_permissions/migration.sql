-- Permissions MCP du site communautaire : lire et modifier le site (réglages,
-- pages, wiki, blog, publication, commentaires).
ALTER TYPE "McpKeyPermission" ADD VALUE IF NOT EXISTS 'READ_SITE';
ALTER TYPE "McpKeyPermission" ADD VALUE IF NOT EXISTS 'WRITE_SITE';
