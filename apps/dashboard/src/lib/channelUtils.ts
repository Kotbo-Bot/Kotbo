export function channelDisplayName(channel: { name: string; type?: string }): string {
  switch (channel.type) {
    case 'voice': return `🔊 ${channel.name}`;
    case 'forum': return `💬 ${channel.name}`;
    case 'media': return `📷 ${channel.name}`;
    case 'thread': return `🧵 ${channel.name}`;
    case 'announcement': return `📢 ${channel.name}`;
    default: return `# ${channel.name}`;
  }
}

/**
 * Options d'une liste d'exceptions. Les catégories viennent en tête : une
 * catégorie exemptée couvre ses salons créés à la volée, tickets compris
 * (#778). Elles s'écrivent en capitales, comme dans la liste des salons de
 * Discord, pour se distinguer sans libellé à traduire.
 */
export function exemptionOptions(
  channels: { id: string; name: string; type?: string }[],
  categories: { id: string; name: string }[],
): { id: string; name: string }[] {
  return [
    ...categories.map((category) => ({ id: category.id, name: category.name.toUpperCase() })),
    ...channels.map((channel) => ({ id: channel.id, name: channelDisplayName(channel) })),
  ];
}
