export interface EmbedComponent {
  type: 'button';
  label: string;
  style: 'primary' | 'secondary' | 'link';
  customId?: string;
  url?: string;
}

export interface SendEmbedParams {
  /** Serveur de la requête : le salon doit lui appartenir. */
  guildId: string;
  channelId: string;
  title: string;
  description: string;
  color: string;
  components?: EmbedComponent[];
}

export interface DiscordMember {
  id: string;
  username: string;
  displayName: string;
  permissions: string[];
  roles: string[];
}

export interface GuildInfo {
  id: string;
  name: string;
  iconUrl: string | null;
  memberCount: number;
}

export interface DiscordPort {
  sendEmbed(params: SendEmbedParams): Promise<{ messageId: string } | null>;
  fetchMember(guildId: string, userId: string): Promise<DiscordMember | null>;
  addRole(guildId: string, userId: string, roleId: string): Promise<boolean>;
  removeRole(guildId: string, userId: string, roleId: string): Promise<boolean>;
  getGuildInfo(guildId: string): Promise<GuildInfo | null>;
}
