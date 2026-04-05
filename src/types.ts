// ── Shared types ───────────────────────────────────────────────────────────
// Re-exported so every module can `import { ... } from "./types.js"`

export type {
  CcgConfig,
  AgentConfig,
  BindingConfig,
  PluginEntry,
  HeartbeatConfig,
} from "./config.js";

// ── Message types ──────────────────────────────────────────────────────────

export interface Attachment {
  type: string;
  url?: string;
  data?: Buffer;
  filename?: string;
}

export interface IncomingMessage {
  from: {
    gateway: string;
    channel: string;
    user: string;
    userId: string;
    messageId: string;
  };
  to: { agent: string };
  content: string;
  attachments: Attachment[];
}
