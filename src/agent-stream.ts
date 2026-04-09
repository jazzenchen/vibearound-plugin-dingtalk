/**
 * AgentStreamHandler — receives ACP session updates from the Host and renders
 * them as DingTalk text/markdown replies via the sessionWebhook.
 *
 * DingTalk does not support editing previously-sent messages, so this
 * handler runs in BlockRenderer send-only mode (no `editBlock` override):
 * intermediate debounced flushes are deferred by the SDK and each sealed
 * block is sent as its own webhook reply, matching qqbot/discord behavior.
 *
 * Agent/session/system notices are fired immediately as separate messages
 * (like qqbot) so the user gets instant feedback instead of waiting for the
 * whole turn to complete before seeing anything.
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
      // DingTalk has no edit support — rely on send-only mode in the SDK to
      // defer intermediate flushes and only send sealed blocks.
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

  /** Send a sealed block as a markdown reply. Returns null (no edit support). */
  protected async sendBlock(
    channelId: string,
    _kind: BlockKind,
    content: string,
  ): Promise<string | null> {
    try {
      await this.dingBot.sendMarkdown(channelId, "VibeAround", content);
    } catch (err) {
      this.log("warn", `sendBlock failed chat=${channelId}: ${String(err)}`);
    }
    return null;
  }

  // Intentionally do NOT override `editBlock`: DingTalk has no edit
  // primitive, and leaving it undefined lets BlockRenderer.flush() detect
  // send-only mode and defer intermediate debounced flushes until the
  // block is sealed. Otherwise the user would see a partial first-flush
  // send AND the final sealed send as two separate replies.

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
      this.dingBot
        .sendText(this.lastChannelId, `🤖 Agent: ${agent} v${version}`)
        .catch(() => {});
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
