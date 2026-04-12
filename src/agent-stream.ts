/**
 * DingTalk stream renderer — send-only (no message editing).
 * Each sealed block is sent as a markdown reply via webhook.
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

  constructor(dingBot: DingTalkBot, log: LogFn, verbose?: Partial<VerboseConfig>) {
    super({
      streaming: false,
      flushIntervalMs: 800,
      verbose,
    });
    this.dingBot = dingBot;
    this.log = log;
  }

  protected async sendText(chatId: string, text: string): Promise<void> {
    await this.dingBot.sendText(chatId, text);
  }

  protected formatContent(kind: BlockKind, content: string, _sealed: boolean): string {
    switch (kind) {
      case "thinking": return `> 💭 ${content}`;
      case "tool":     return `\`${content.trim()}\``;
      case "text":     return content;
    }
  }

  protected async sendBlock(chatId: string, _kind: BlockKind, content: string): Promise<string | null> {
    try {
      await this.dingBot.sendMarkdown(chatId, "VibeAround", content);
    } catch (err) {
      this.log("warn", `sendBlock failed chat=${chatId}: ${String(err)}`);
    }
    return null;
  }
}
