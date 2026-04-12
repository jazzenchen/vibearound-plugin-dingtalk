#!/usr/bin/env node
/**
 * VibeAround DingTalk Plugin — ACP Client
 *
 * Spawned by the Rust host as a child process.
 * DingTalk uses Stream API (WebSocket) — no public IP required.
 */

import { runChannelPlugin } from "@vibearound/plugin-channel-sdk";

import { DingTalkBot } from "./bot.js";
import { AgentStreamHandler } from "./agent-stream.js";

runChannelPlugin({
  name: "vibearound-dingtalk",
  version: "0.1.0",
  requiredConfig: ["client_id", "client_secret"],
  createBot: ({ config, agent, log, cacheDir }) =>
    new DingTalkBot(
      {
        client_id: config.client_id as string,
        client_secret: config.client_secret as string,
      },
      agent,
      log,
      cacheDir,
    ),
  createRenderer: (bot, log, verbose) =>
    new AgentStreamHandler(bot, log, verbose),
});
