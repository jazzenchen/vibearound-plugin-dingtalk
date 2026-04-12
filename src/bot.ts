/**
 * DingTalkBot — wraps the dingtalk-stream SDK for Stream API messaging.
 *
 * Handles:
 *   - DWClient connection lifecycle (WebSocket, no public IP)
 *   - Inbound message parsing → ACP prompt() to Host
 *   - Reply via sessionWebhook (temporary URL in each message)
 */

import fs from "node:fs/promises";
import path from "node:path";
import axios from "axios";
import {
  DWClient,
  TOPIC_ROBOT,
  type DWClientDownStream,
} from "dingtalk-stream";
import type { Agent, ContentBlock } from "@vibearound/plugin-channel-sdk";
import { extractErrorMessage } from "@vibearound/plugin-channel-sdk";
import type { AgentStreamHandler } from "./agent-stream.js";

interface DownloadedImage {
  readonly path: string;
  readonly mimeType: string;
  readonly fileName: string;
}

export interface DingTalkConfig {
  client_id: string;
  client_secret: string;
}

/**
 * DingTalk robot message — broader shape than the SDK's typed RobotMessage
 * (which only covers msgtype: "text"). Real DingTalk also sends "picture",
 * "richText", "audio", "file", etc.
 */
interface RobotMessageAny {
  msgtype: string;
  conversationId?: string;
  conversationType?: string;
  senderStaffId?: string;
  senderNick?: string;
  msgId?: string;
  sessionWebhook?: string;
  sessionWebhookExpiredTime?: number;
  // Text
  text?: { content?: string };
  // Picture / rich text. DingTalk nests everything inside `content`:
  //   picture  → content.downloadCode / content.pictureDownloadCode
  //   richText → content.richText = [{ text? }, { pictureDownloadCode, downloadCode }, ...]
  // Parts in richText do NOT carry a `type` discriminator; they are
  // distinguished by which fields are present.
  content?: {
    downloadCode?: string;
    type?: string;
    richText?: Array<{
      type?: string;
      text?: string;
      downloadCode?: string;
      pictureDownloadCode?: string;
    }>;
  };
  picture?: { picURL?: string };
  [key: string]: unknown;
}

type LogFn = (level: string, msg: string) => void;

export class DingTalkBot {
  private client: DWClient;
  private agent: Agent;
  private log: LogFn;
  private cacheDir: string;
  private streamHandler: AgentStreamHandler | null = null;
  /** Stable client id for robot — used as robotCode in the download API. */
  private readonly clientId: string;
  // Map sessionId (chatId) → latest sessionWebhook for replies
  private webhooks = new Map<string, { url: string; expires: number }>();

  constructor(config: DingTalkConfig, agent: Agent, log: LogFn, cacheDir: string) {
    this.agent = agent;
    this.log = log;
    this.cacheDir = cacheDir;
    this.clientId = config.client_id;

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
  private getWebhook(chatId: string): string | null {
    const entry = this.webhooks.get(chatId);
    if (!entry) return null;
    if (Date.now() >= entry.expires) {
      this.webhooks.delete(chatId);
      return null;
    }
    return entry.url;
  }

  /** Send a text reply to a DingTalk session via the sessionWebhook URL. */
  async sendText(chatId: string, text: string): Promise<void> {
    const webhook = this.getWebhook(chatId);
    if (!webhook) {
      this.log("warn", `no valid webhook for channel=${chatId}, dropping reply`);
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
  async sendMarkdown(chatId: string, title: string, markdown: string): Promise<void> {
    const webhook = this.getWebhook(chatId);
    if (!webhook) {
      this.log("warn", `no valid webhook for channel=${chatId}, dropping reply`);
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
        const robotMessage = JSON.parse(res.data) as RobotMessageAny;
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

  private async handleRobotMessage(msg: RobotMessageAny): Promise<void> {
    const chatId = msg.conversationId ?? "unknown";
    const senderId = msg.senderStaffId ?? "unknown";
    const msgId = (msg.msgId as string | undefined) ?? "unknown";

    // Diagnostic: log the raw shape of non-text messages so we can see the
    // exact field layout DingTalk uses for picture / richText. Rendered as
    // a truncated one-liner so it doesn't blow up the log.
    if (msg.msgtype !== "text") {
      const raw = JSON.stringify(msg);
      this.log(
        "debug",
        `raw msgtype=${msg.msgtype} chat=${chatId}: ${raw.slice(0, 800)}`,
      );
    }

    // Cache the webhook for replies (always, even for non-text messages)
    if (msg.sessionWebhook) {
      const expires = msg.sessionWebhookExpiredTime
        ? msg.sessionWebhookExpiredTime
        : Date.now() + 5 * 60 * 1000; // default 5 min
      this.webhooks.set(chatId, { url: msg.sessionWebhook, expires });
    }

    // Build content blocks based on msgtype. For picture and richText we
    // download the referenced images into the plugin cache and emit
    // file:// resource_link blocks — mirrors how feishu/discord/wecom hand
    // media to the agent so ACPPod can relocate them into the workspace
    // cache where Claude can actually read them.
    const contentBlocks: ContentBlock[] = [];
    let preview = "";

    switch (msg.msgtype) {
      case "text": {
        const text = msg.text?.content?.trim() ?? "";
        if (!text) {
          this.log("debug", `empty text message ignored chat=${chatId}`);
          return;
        }
        contentBlocks.push({ type: "text", text });
        preview = text;
        break;
      }
      case "picture":
      case "image": {
        const downloadCode = msg.content?.downloadCode;
        if (!downloadCode) {
          this.log(
            "warn",
            `picture message chat=${chatId} missing downloadCode; falling back to placeholder`,
          );
          contentBlocks.push({
            type: "text",
            text: "[The user sent an image but the download code was missing.]",
          });
          preview = "(image:nodl)";
          break;
        }
        const local = await this.downloadImage(chatId, msgId, 0, downloadCode).catch(
          (err: unknown) => {
            this.log(
              "warn",
              `failed to download image chat=${chatId} code=${downloadCode}: ${extractErrorMessage(err)}`,
            );
            return null;
          },
        );
        if (local) {
          contentBlocks.push({ type: "text", text: "The user sent an image." });
          contentBlocks.push({
            type: "resource_link",
            uri: `file://${local.path}`,
            name: local.fileName,
            mimeType: local.mimeType,
          });
          preview = "(image)";
        } else {
          contentBlocks.push({
            type: "text",
            text: "[The user sent an image but the download failed. Please ask them to describe it.]",
          });
          preview = "(image:dlerr)";
        }
        break;
      }
      case "richText": {
        // Mixed content — interleave text and picture parts in order.
        const parts = msg.content?.richText ?? [];
        const textParts: string[] = [];
        const downloadCodes: string[] = [];
        // DingTalk richText parts are discriminated by field presence,
        // not by a `type` field: a part with `text` is a text segment,
        // a part with `downloadCode` is a picture segment.
        for (const part of parts) {
          if (typeof part.text === "string" && part.text.trim()) {
            textParts.push(part.text.trim());
          }
          if (typeof part.downloadCode === "string" && part.downloadCode) {
            downloadCodes.push(part.downloadCode);
          }
        }

        const combined = textParts.join("\n").trim();
        if (combined) {
          contentBlocks.push({ type: "text", text: combined });
        } else if (downloadCodes.length > 0) {
          contentBlocks.push({
            type: "text",
            text: `The user sent ${downloadCodes.length} image${downloadCodes.length > 1 ? "s" : ""}.`,
          });
        }

        let downloadedCount = 0;
        for (let i = 0; i < downloadCodes.length; i += 1) {
          const code = downloadCodes[i];
          if (!code) continue;
          const local = await this.downloadImage(chatId, msgId, i, code).catch(
            (err: unknown) => {
              this.log(
                "warn",
                `failed to download richText image[${i}] chat=${chatId}: ${extractErrorMessage(err)}`,
              );
              return null;
            },
          );
          if (local) {
            contentBlocks.push({
              type: "resource_link",
              uri: `file://${local.path}`,
              name: local.fileName,
              mimeType: local.mimeType,
            });
            downloadedCount += 1;
          }
        }

        if (contentBlocks.length === 0) {
          this.log("debug", `empty richText ignored chat=${chatId}`);
          return;
        }
        preview = combined.slice(0, 60) || `(richText: ${downloadedCount}/${downloadCodes.length} images)`;
        break;
      }
      default: {
        this.log("warn", `unsupported msgtype=${msg.msgtype} chat=${chatId}`);
        // Tell the user we got something we can't handle
        await this.sendText(
          chatId,
          `(Unsupported message type: ${msg.msgtype}. Please send text.)`,
        );
        return;
      }
    }

    if (contentBlocks.length === 0) return;

    this.log("debug", `message chat=${chatId} sender=${senderId} type=${msg.msgtype} preview=${preview}`);

    this.streamHandler?.onPromptSent(chatId);

    try {
      const response = await this.agent.prompt({
        sessionId: chatId,
        prompt: contentBlocks,
      });
      this.log("info", `prompt done chat=${chatId} stopReason=${response.stopReason}`);
      this.streamHandler?.onTurnEnd(chatId);
    } catch (error: unknown) {
      const errMsg = extractErrorMessage(error);
      this.log("error", `prompt failed chat=${chatId}: ${errMsg}`);
      this.streamHandler?.onTurnError(chatId, errMsg);
    }
  }

  /**
   * Download a DingTalk robot image by its downloadCode and cache it
   * locally. DingTalk's stream protocol doesn't ship raw image bytes —
   * callers have to exchange the downloadCode for a short-lived direct
   * URL via POST /v1.0/robot/messageFiles/download (using
   * `x-acs-dingtalk-access-token` auth), then GET that URL.
   *
   * Cached by msgId so retries of the same message don't re-download.
   */
  private async downloadImage(
    chatId: string,
    msgId: string,
    index: number,
    downloadCode: string,
  ): Promise<DownloadedImage> {
    const safeChannel = chatId.replace(/[^a-zA-Z0-9._-]/g, "_");
    const dir = path.join(this.cacheDir, "dingtalk", safeChannel);
    // downloadCode is long and URL-unsafe; use msgId+index for filename.
    // msgId can contain `/`, `+`, `=` (e.g. `msgSaRR7+PVL/TrTU3EqCCFvQ==`)
    // — the unsanitized `/` turns the filename into a phantom subdirectory
    // and fs.writeFile blows up with ENOENT. Sanitize it the same way we
    // sanitize the chatId.
    const safeMsgId = msgId.replace(/[^a-zA-Z0-9._-]/g, "_");
    const baseName = `${safeMsgId}-${index}`;

    // Fast path: if we've already cached a file with any extension for this
    // (msg, index), use it. We search the directory because we learn the
    // extension only after the download.
    try {
      const entries = await fs.readdir(dir);
      const hit = entries.find((name) => name.startsWith(`${baseName}.`));
      if (hit) {
        const cachedPath = path.join(dir, hit);
        this.log("debug", `image cache hit: ${cachedPath}`);
        return {
          path: cachedPath,
          mimeType: mimeFromExt(path.extname(hit)),
          fileName: hit,
        };
      }
    } catch {
      // dir doesn't exist yet, proceed
    }

    this.log(
      "debug",
      `resolving downloadCode chat=${chatId} msgId=${msgId} idx=${index}`,
    );

    const accessToken = await this.client.getAccessToken();
    if (!accessToken || typeof accessToken !== "string") {
      throw new Error("dingtalk access token unavailable");
    }

    // Step 1: exchange downloadCode for a short-lived downloadUrl.
    const resolveRes = await axios.post<{ downloadUrl?: string }>(
      "https://api.dingtalk.com/v1.0/robot/messageFiles/download",
      {
        downloadCode,
        robotCode: this.clientId,
      },
      {
        headers: {
          "x-acs-dingtalk-access-token": accessToken,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      },
    );
    const downloadUrl = resolveRes.data?.downloadUrl;
    if (!downloadUrl) {
      throw new Error("dingtalk resolve returned no downloadUrl");
    }

    // Step 2: fetch the actual bytes.
    const fileRes = await axios.get<ArrayBuffer>(downloadUrl, {
      responseType: "arraybuffer",
      timeout: 30000,
    });
    const buffer = Buffer.from(fileRes.data);

    // Infer extension from Content-Type, defaulting to .jpg.
    const contentType = (fileRes.headers["content-type"] as string | undefined) ?? "image/jpeg";
    const ext = extFromMime(contentType);
    const fileName = `${baseName}${ext}`;
    const localPath = path.join(dir, fileName);

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(localPath, buffer);
    this.log(
      "debug",
      `cached dingtalk image ${buffer.length} bytes → ${localPath}`,
    );

    return {
      path: localPath,
      mimeType: contentType,
      fileName,
    };
  }
}

function mimeFromExt(ext: string): string {
  const lower = ext.toLowerCase();
  if (lower === ".png") return "image/png";
  if (lower === ".gif") return "image/gif";
  if (lower === ".webp") return "image/webp";
  if (lower === ".bmp") return "image/bmp";
  return "image/jpeg";
}

function extFromMime(mime: string): string {
  const lower = mime.toLowerCase();
  if (lower.includes("png")) return ".png";
  if (lower.includes("gif")) return ".gif";
  if (lower.includes("webp")) return ".webp";
  if (lower.includes("bmp")) return ".bmp";
  return ".jpg";
}
