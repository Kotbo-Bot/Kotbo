import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';

const CommitSchema = z.object({
  hash: z.string(),
  date: z.string(),
  title: z.string(),
  description: z.string(),
  type: z.string(),
  scope: z.string().nullable(),
});

const ChangelogResponseSchema = z.object({
  commits: z.array(CommitSchema),
});

const getChangelogRoute = createRoute({
  method: 'get',
  path: '/api/public/changelog',
  summary: 'Liste des derniers commits du projet Kotbo',
  tags: ['PublicChangelog'],
  request: {
    query: z.object({
      limit: z.string().optional().openapi({ description: 'Nombre de commits à retourner (max 50)', example: '20' }),
    }),
  },
  responses: {
    200: {
      description: 'Liste des commits',
      content: {
        'application/json': {
          schema: ChangelogResponseSchema,
        },
      },
    },
  },
});

function parseConventionalCommit(message: string): { type: string; scope: string | null; title: string; description: string } {
  const firstLine = message.split('\n')[0];
  const body = message.split('\n').slice(1).join('\n').trim();

  const match = firstLine.match(/^(\w+)(?:\(([^)]+)\))?:\s*(.+)$/);
  if (match) {
    return {
      type: match[1],
      scope: match[2] || null,
      title: match[3].trim(),
      description: body,
    };
  }

  return {
    type: 'other',
    scope: null,
    title: firstLine,
    description: body,
  };
}

let cachedResult: { commits: any[]; fetchedAt: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000;

export function createChangelogRouter() {
  const router = new OpenAPIHono();

  router.openapi(getChangelogRoute, async (c) => {
    const limitParam = c.req.query('limit');
    const limit = Math.min(Math.max(parseInt(limitParam || '20', 10) || 20, 1), 50);

    if (cachedResult && Date.now() - cachedResult.fetchedAt < CACHE_TTL) {
      return c.json({ commits: cachedResult.commits.slice(0, limit) });
    }

    try {
      const separator = '---COMMIT_SEP---';
      const fieldSep = '---FIELD_SEP---';
      // Asynchrone : execSync figeait toute l'API jusqu'à 5 s à chaque cache expiré.
      const proc = Bun.spawn(
        ['git', 'log', '--max-count=50', `--format=${separator}%H${fieldSep}%aI${fieldSep}%B`, 'HEAD'],
        { stdout: 'pipe', stderr: 'ignore', timeout: 5000 },
      );
      const [raw, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      if (code !== 0) throw new Error(`git log: code ${code}`);

      const commits = raw
        .split(separator)
        .filter((s) => s.trim())
        .map((entry) => {
          const [hash, date, ...messageParts] = entry.split(fieldSep);
          const message = messageParts.join(fieldSep).trim();
          const parsed = parseConventionalCommit(message);
          return {
            hash: hash.trim(),
            date: date.trim(),
            title: parsed.title,
            description: parsed.description,
            type: parsed.type,
            scope: parsed.scope,
          };
        });

      cachedResult = { commits, fetchedAt: Date.now() };
      return c.json({ commits: commits.slice(0, limit) });
    } catch {
      return c.json({ commits: [] });
    }
  });

  return router;
}
