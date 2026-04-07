# @vibearound/plugin-dingtalk

DingTalk (钉钉) channel plugin for [VibeAround](https://github.com/jazzenchen/VibeAround).

Connects DingTalk to your VibeAround agents using **Stream Mode** — a persistent WebSocket connection. **No public IP, no webhook URL, no port forwarding required.**

## Features

- WebSocket persistent connection (DingTalk Stream API)
- Auto reconnect with exponential backoff
- DM and group chat support
- Markdown reply formatting
- Reply via `sessionWebhook` (5-minute validity per message)

## Prerequisites

- Node.js 20+
- A DingTalk Developer account
- A registered DingTalk app with Robot capability

## DingTalk app setup

Follow the official guide:
[钉钉机器人手动配置 — DingTalk Open Platform](https://open.dingtalk.com/document/dingstart/dingtalk-ai-employees-manual-configuration)

### Quick steps

1. Go to [open-dev.dingtalk.com](https://open-dev.dingtalk.com/) and **create an Enterprise Internal App**
2. In **基本信息 (Basic Info)** → copy the **AppKey (Client ID)** and **AppSecret (Client Secret)**
3. In **应用功能 → 机器人 (Robot)** → enable the Robot capability
4. In **应用功能 → 事件订阅 (Event Subscription)**:
   - Set **推送方式 (Push Mode)** to **Stream模式推送 (Stream Mode)**
   - Click **保存 (Save)**
5. **Subscribe to the robot message event** (机器人消息接收事件)
6. **Publish (发布)** the app — at minimum, publish to the development version

> **Important:** The app must be **published** (开发版 or higher) for the bot to receive messages, even during testing.

## Configuration

Add this to your VibeAround `settings.json`:

```json
{
  "channels": {
    "dingtalk": {
      "client_id": "<your AppKey>",
      "client_secret": "<your AppSecret>"
    }
  }
}
```

| Field | Description |
|---|---|
| `client_id` | DingTalk **AppKey** from 应用基本信息 |
| `client_secret` | DingTalk **AppSecret** from 应用基本信息 |

Or configure it through the VibeAround onboarding wizard — the Channels step has a DingTalk card.

## Usage

Once VibeAround is running and the DingTalk plugin is enabled:

1. In the DingTalk app, find your bot and start a chat
2. Send a message — the bot replies via the agent
3. In **Event Subscription** settings, click **"已完成接入，验证连接通道"** (Validate Connection) — it should succeed because the Stream client is live

### Slash commands

VibeAround system commands work in DingTalk:

```
/help            Show available commands
/new             Reset the conversation
/switch <agent>  Switch agent (claude, gemini, codex, cursor, kiro, qwen-code)
/handover        Hand the session back to a coding agent CLI
```

## Limitations

- **No streaming replies** — DingTalk's `sessionWebhook` only accepts complete messages. The plugin sends each block as a new reply.
- **No file/image input** — DingTalk file handling is not yet implemented.
- **Webhook expiry** — replies must be sent within ~5 minutes of receiving the message; longer agent runs may miss the window.

A future version may use DingTalk **AI Card streaming** (`Card.Streaming.Write` permission) for true streaming responses. This requires enabling the corresponding permissions in the DingTalk app settings.

## Architecture

```
DingTalk Server
       ↑↓ WebSocket (Stream API, outbound only)
DingTalk Plugin (Node.js)
       ↑↓ ACP over stdio
VibeAround Host (Rust)
       ↓
Agent (Claude / Gemini / Cursor / ...)
```

The plugin uses [`dingtalk-stream`](https://www.npmjs.com/package/dingtalk-stream) (the official Node.js SDK) and registers a `TOPIC_ROBOT` callback to receive messages.

## License

MIT
