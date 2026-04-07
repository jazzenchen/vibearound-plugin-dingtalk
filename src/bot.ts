/**
 * DingTalkBot — wraps the dingtalk-stream SDK for Stream API messaging.
 *
 * Handles:
 *   - DWClient connection lifecycle (WebSocket, no public IP)
 *   - Inbound message parsing → ACP prompt() to Host
 *   - Reply via sessionWebhook (temporary URL in each message)
 */

import axios from "axios";
import {
  DWClient,
  TOPIC_ROBOT,
  type DWClientDownStream,
  type RobotMessage,
} from "dingtalk-stream";
import type { Agent, ContentBlock } from "@vibearound/plugin-channel-sdk";
import type { AgentStreamHandler } from "./agent-stream.js";

export interface DingTalkConfig {
  client_id: string;
  client_secret: string;
}

type LogFn = (level: string, msg: string) => void;

export class DingTalkBot {
  private client: DWClient;
  private agent: Agent;
  private log: LogFn;
  private cacheDir: string;
  private streamHandler: AgentStreamHandler | null = null;
  // Map sessionId (chatId) → latest sessionWebhook for replies
  private webhooks = new Map<string, { url: string; expires: number }>();

  constructor(config: DingTalkConfig, agent: Agent, log: LogFn, cacheDir: string) {
    this.agent = agent;
    this.log = log;
    this.cacheDir = cacheDir;

    this.client = new DWClient({
      clientId: config.client_id,
      clientSecret: config.client_secret,
      debug: false,
    });
  }

  setStreamHandler(handler: AgentStreamHandler): void {
    this.streamHandler = handler;
  }

  /** Get the latest webhook for a session, if still valid. */
  private getWebhook(channelId: string): string | null {
    const entry = this.webhooks.get(channelId);
    if (!entry) return null;
    if (Date.now() >= entry.expires) {
      this.webhooks.delete(channelId);
      return null;
    }
    return entry.url;
  }

  /** Send a text reply to a DingTalk session via the sessionWebhook URL. */
  async sendText(channelId: string, text: string): Promise<void> {
    const webhook = this.getWebhook(channelId);
    if (!webhook) {
      this.log("warn", `no valid webhook for channel=${channelId}, dropping reply`);
      return;
    }
    try {
      await axios.post(
        webhook,
        {
          msgtype: "text",
          text: { content: text },
        },
        { timeout: 10000 },
      );
    } catch (e) {
      const err = e as { message?: string };
      this.log("error", `sendText failed: ${err.message ?? String(e)}`);
    }
  }

  /** Send a markdown reply via the sessionWebhook URL. */
  async sendMarkdown(channelId: string, title: string, markdown: string): Promise<void> {
    const webhook = this.getWebhook(channelId);
    if (!webhook) {
      this.log("warn", `no valid webhook for channel=${channelId}, dropping reply`);
      return;
    }
    try {
      await axios.post(
        webhook,
        {
          msgtype: "markdown",
          markdown: { title, text: markdown },
        },
        { timeout: 10000 },
      );
    } catch (e) {
      const err = e as { message?: string };
      this.log("error", `sendMarkdown failed: ${err.message ?? String(e)}`);
    }
  }

  async start(): Promise<void> {
    // Register robot message callback
    this.client.registerCallbackListener(TOPIC_ROBOT, (res: DWClientDownStream) => {
      try {
        const robotMessage = JSON.parse(res.data) as RobotMessage;
        // Fire-and-forget — DingTalk SDK callback signature is sync
        void this.handleRobotMessage(robotMessage);
      } catch (e) {
        this.log("error", `failed to parse robot message: ${e}`);
      }

      // Acknowledge message to prevent re-delivery
      try {
        this.client.socketCallBackResponse(res.headers.messageId, {
          response: { statusLine: { code: 200, reasonPhrase: "OK" } },
        });
      } catch {
        // ignore ack failure
      }
    });

    // Start the WebSocket connection
    await this.client.connect();
    this.log("info", "DingTalk Stream client connected");
  }

  async stop(): Promise<void> {
    try {
      this.client.disconnect();
    } catch {
      // ignore
    }
  }

  private async handleRobotMessage(msg: RobotMessage): Promise<void> {
    const text = msg.text?.content?.trim() ?? "";
    // Use conversationId as the channel/session id
    const channelId = msg.conversationId ?? "unknown";
    const senderId = msg.senderStaffId ?? "unknown";

    if (!text) {
      this.log("debug", `empty message ignored chat=${channelId}`);
      return;
    }

    // Cache the webhook for replies
    if (msg.sessionWebhook) {
      const expires = msg.sessionWebhookExpiredTime
        ? msg.sessionWebhookExpiredTime
        : Date.now() + 5 * 60 * 1000; // default 5 min
      this.webhooks.set(channelId, { url: msg.sessionWebhook, expires });
    }

    this.log("debug", `message chat=${channelId} sender=${senderId} text=${text.slice(0, 80)}`);

    const contentBlocks: ContentBlock[] = [{ type: "text", text }];

    this.streamHandler?.onPromptSent(channelId);

    try {
      const response = await this.agent.prompt({
        sessionId: channelId,
        prompt: contentBlocks,
      });
      this.log("info", `prompt done chat=${channelId} stopReason=${response.stopReason}`);
      this.streamHandler?.onTurnEnd(channelId);
    } catch (error: unknown) {
      const errMsg =
        error instanceof Error
          ? error.message
          : typeof error === "object" && error !== null && "message" in error
            ? String((error as { message: unknown }).message)
            : String(error);
      this.log("error", `prompt failed chat=${channelId}: ${errMsg}`);
      this.streamHandler?.onTurnError(channelId, errMsg);
    }
  }
}
