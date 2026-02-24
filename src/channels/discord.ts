import {
  Client,
  GatewayIntentBits,
  Message,
  Partials,
  TextBasedChannel,
  TextChannel,
} from 'discord.js';

import { logger } from '../logger.js';
import { Channel, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';

const JID_SUFFIX = '@discord';

export interface DiscordChannelOpts {
  token: string;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export function discordJid(channelId: string): string {
  return `${channelId}${JID_SUFFIX}`;
}

export class DiscordChannel implements Channel {
  name = 'discord';
  private client: Client;
  private connected = false;
  private opts: DiscordChannelOpts;
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  constructor(opts: DiscordChannelOpts) {
    this.opts = opts;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.client.once('ready', () => {
        this.connected = true;
        logger.info({ tag: this.client.user?.tag }, 'Connected to Discord');
        resolve();
      });

      this.client.on('error', (err) => {
        logger.error({ err }, 'Discord client error');
      });

      this.client.on('messageCreate', (message: Message) => {
        this.handleMessage(message).catch((err) => {
          logger.error({ err }, 'Error handling Discord message');
        });
      });

      this.client.login(this.opts.token).catch(reject);
    });
  }

  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot) return;

    const channelId = message.channelId;
    const jid = discordJid(channelId);
    const timestamp = message.createdAt.toISOString();
    const isGuild = message.guild !== null;
    const channelName =
      message.channel instanceof TextChannel
        ? message.channel.name
        : undefined;

    this.opts.onChatMetadata(jid, timestamp, channelName, 'discord', isGuild);

    const groups = this.opts.registeredGroups();
    if (!groups[jid]) return;

    const content = message.content;
    if (!content) return;

    const sender = message.author.id;
    const senderName =
      (message.member?.displayName ?? message.author.displayName) ||
      message.author.username;

    this.opts.onMessage(jid, {
      id: message.id,
      chat_jid: jid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = jid.slice(0, -JID_SUFFIX.length);
    const ch = await this.client.channels.fetch(channelId);
    if (!ch || !ch.isTextBased()) {
      throw new Error(
        `Discord channel not found or not text-based: ${channelId}`,
      );
    }
    // Discord has a 2000-char limit per message
    for (const chunk of splitMessage(text, 2000)) {
      await (ch as TextBasedChannel & { send: (s: string) => Promise<unknown> }).send(chunk);
    }
    logger.info({ jid, length: text.length }, 'Discord message sent');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith(JID_SUFFIX);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();
    await this.client.destroy();
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const channelId = jid.slice(0, -JID_SUFFIX.length);

    if (isTyping) {
      const sendTyping = async () => {
        try {
          const ch = await this.client.channels.fetch(channelId);
          if (ch?.isTextBased()) {
            await (ch as TextChannel).sendTyping();
          }
        } catch {
          // Non-fatal — typing indicator is best-effort
        }
      };
      await sendTyping();
      // Discord typing indicator expires after ~10s, refresh every 8s
      const interval = setInterval(sendTyping, 8000);
      this.typingIntervals.set(jid, interval);
    } else {
      const interval = this.typingIntervals.get(jid);
      if (interval) {
        clearInterval(interval);
        this.typingIntervals.delete(jid);
      }
    }
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    const splitAt = remaining.lastIndexOf('\n', maxLen);
    const cut = splitAt > 0 ? splitAt : maxLen;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
