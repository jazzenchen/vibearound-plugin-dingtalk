/**
 * AgentStreamHandler — receives ACP session updates from the Host and renders
 * them as DingTalk text/markdown replies via the sessionWebhook.
 *
 * DingTalk does not support editing previously-sent messages, so this renderer
 * sends each completed block as a new message.
 */

import {
  BlockRenderer,
  type BlockKind,
  type VerboseConfig,
} from "@vibearound/plugin-channel-sdk";
import type { DingTalkBot } from "./bot.js";

type LogFn = (level: string, msg: string) => void;

export class AgentStreamHandler extends BlockRenderer<string> {
  private dingBot: DingTalkBot;
  private log: LogFn;
  private lastChannelId: string | null = null;

  constructor(dingBot: DingTalkBot, log: LogFn, verbose?: Partial<VerboseConfig>) {
    super({
      flushIntervalMs: 800,
      // DingTalk has no edit support — sealing on every flush would spam.
      // Set a high min edit interval; sendBlock will return null so editBlock
      // is never called.
      minEditIntervalMs: 60_000,
      verbose,
    });
    this.dingBot = dingBot;
    this.log = log;
  }

  protected formatContent(kind: BlockKind, content: string, _sealed: boolean): string {
    switch (kind) {
      case "thinking":
        return `> 💭 ${content}`;
      case "tool":
        return `\`${content.trim()}\``;
      case "text":
        return content;
    }
  }

  /** Send a new message via DingTalk webhook. Returns null (no edit support). */
  protected async sendBlock(
    channelId: string,
    kind: BlockKind,
    content: string,
  ): Promise<string | null> {
    if (kind === "text") {
      // Use markdown for richer formatting
      await this.dingBot.sendMarkdown(channelId, "VibeAround", content);
    } else {
      await this.dingBot.sendText(channelId, content);
    }
    return null; // no edit support
  }

  /** No-op: DingTalk does not support editing messages via webhook. */
  protected async editBlock(
    _channelId: string,
    _ref: string,
    _kind: BlockKind,
    _content: string,
    _sealed: boolean,
  ): Promise<void> {
    // not supported
  }

  protected async onAfterTurnEnd(channelId: string): Promise<void> {
    this.log("debug", `turn_complete session=${channelId}`);
  }

  protected async onAfterTurnError(channelId: string, error: string): Promise<void> {
    await this.dingBot.sendText(channelId, `❌ Error: ${error}`);
  }

  onPromptSent(channelId: string): void {
    this.lastChannelId = channelId;
    super.onPromptSent(channelId);
  }

  onAgentReady(agent: string, version: string): void {
    if (this.lastChannelId) {
      this.dingBot.sendText(this.lastChannelId, `🤖 Agent: ${agent} v${version}`).catch(() => {});
    }
  }

  onSessionReady(sessionId: string): void {
    if (this.lastChannelId) {
      this.dingBot
        .sendText(this.lastChannelId, `📋 Session: ${sessionId}`)
        .catch(() => {});
    }
  }

  onSystemText(text: string): void {
    if (this.lastChannelId) {
      this.dingBot.sendText(this.lastChannelId, text).catch(() => {});
    }
  }
}
