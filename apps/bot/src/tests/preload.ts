// Bun charge le .env du launcher, où SHARD_COUNT vaut « auto » : un Client
// discord.js construit dans un test lit ce Number('auto') et refuse de démarrer.
if (process.env.SHARD_COUNT === 'auto') delete process.env.SHARD_COUNT;
