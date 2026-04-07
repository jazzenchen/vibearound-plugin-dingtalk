/**
 * AgentStreamHandler — receives ACP session updates from the Host and renders
 * them as DingTalk text/markdown replies via the sessionWebhook.
 *
 * DingTalk does not support editing previously-sent messages, and the
 * sessionWebhook only accepts a few replies before the user perceives spam.
 * So this renderer BUFFERS all content during the turn and sends ONE final
 * markdown message in `onAfterTurnEnd`.
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

  /** Persistent header per turn (agent info, session id, system messages). */
  private header = new Map<string, string[]>();
  /** Sealed (completed) blocks from this turn. */
  private sealedBlocks = new Map<string, string[]>();
  /** Currently-streaming block content. */
  private currentBlock = new Map<string, string>();

  constructor(dingBot: DingTalkBot, log: LogFn, verbose?: Partial<VerboseConfig>) {
    super({
      flushIntervalMs: 800,
      // DingTalk has no edit support — buffer everything until turn ends.
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

  /**
   * A new block starts. Seal the previous current block, then store the new
   * one. Do NOT send to DingTalk yet — wait for turn end.
   */
  protected async sendBlock(
    channelId: string,
    _kind: BlockKind,
    content: string,
  ): Promise<string | null> {
    const prev = this.currentBlock.get(channelId);
    if (prev) {
      const sealed = this.sealedBlocks.get(channelId) ?? [];
      sealed.push(prev);
      this.sealedBlocks.set(channelId, sealed);
    }
    this.currentBlock.set(channelId, content);
    return "buffered"; // non-null so editBlock is preferred over sendBlock for updates
  }

  /** Replace currentBlock with the latest content. Buffer only. */
  protected async editBlock(
    channelId: string,
    _ref: string,
    _kind: BlockKind,
    content: string,
    _sealed: boolean,
  ): Promise<void> {
    this.currentBlock.set(channelId, content);
  }

  /** Build the full message = header + sealed blocks + current block. */
  private buildFull(channelId: string): string {
    const header = this.header.get(channelId) ?? [];
    const sealed = this.sealedBlocks.get(channelId) ?? [];
    const current = this.currentBlock.get(channelId) ?? "";
    const parts: string[] = [];
    if (header.length > 0) parts.push(header.join("\n"));
    if (sealed.length > 0) parts.push(sealed.join("\n\n"));
    if (current) parts.push(current);
    return parts.join("\n\n");
  }

  protected async onAfterTurnEnd(channelId: string): Promise<void> {
    // Seal the final current block
    const prev = this.currentBlock.get(channelId);
    if (prev) {
      const sealed = this.sealedBlocks.get(channelId) ?? [];
      sealed.push(prev);
      this.sealedBlocks.set(channelId, sealed);
      this.currentBlock.delete(channelId);
    }

    const full = this.buildFull(channelId);
    if (full) {
      await this.dingBot.sendMarkdown(channelId, "VibeAround", full);
    }

    // Clear state for next turn
    this.header.delete(channelId);
    this.sealedBlocks.delete(channelId);
    this.currentBlock.delete(channelId);
    this.log("debug", `turn_complete session=${channelId}`);
  }

  protected async onAfterTurnError(channelId: string, error: string): Promise<void> {
    await this.dingBot.sendText(channelId, `❌ Error: ${error}`);
    this.header.delete(channelId);
    this.sealedBlocks.delete(channelId);
    this.currentBlock.delete(channelId);
  }

  onPromptSent(channelId: string): void {
    // Clear leftover state for new turn
    this.header.delete(channelId);
    this.sealedBlocks.delete(channelId);
    this.currentBlock.delete(channelId);
    this.lastChannelId = channelId;
    super.onPromptSent(channelId);
  }

  onAgentReady(agent: string, version: string): void {
    if (this.lastChannelId) {
      const header = this.header.get(this.lastChannelId) ?? [];
      header.push(`🤖 Agent: ${agent} v${version}`);
      this.header.set(this.lastChannelId, header);
    }
  }

  onSessionReady(sessionId: string): void {
    if (this.lastChannelId) {
      const header = this.header.get(this.lastChannelId) ?? [];
      header.push(`📋 Session: ${sessionId}`);
      this.header.set(this.lastChannelId, header);
    }
  }

  onSystemText(text: string): void {
    if (this.lastChannelId) {
      const header = this.header.get(this.lastChannelId) ?? [];
      header.push(text);
      this.header.set(this.lastChannelId, header);
    }
  }
}
