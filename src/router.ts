import type { AgentRegistry } from "./agents.js";
import type { SessionManager } from "./sessions.js";
import type { ContextBuilder } from "./context.js";
import type { CCSpawner, ImageInput, StreamCallback } from "./spawner.js";
import type { AsyncTaskWatcher } from "./async-watcher.js";
import type { IncomingMessage, Attachment, BindingConfig } from "./types.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getCcgHome } from "./config.js";
import { logger } from "./logger.js";

// ── Trivial message short-circuit ─────────────────────────────────────────

const TRIVIAL_PATTERN =
  /^(thanks|thank you|ty|thx|ok|okay|k|got it|cool|nice|great|awesome|perfect|sounds good|lgtm|np|no worries|👍|🙏|❤️|💯)[\s!.\-]*$/i;

const TRIVIAL_REPLIES = [
  "You're welcome!",
  "Anytime!",
  "Happy to help!",
  "No problem!",
  "Glad I could help!",
];

function pickTrivialReply(): string {
  return TRIVIAL_REPLIES[Math.floor(Math.random() * TRIVIAL_REPLIES.length)];
}

// ── MessageRouter ─────────────────────────────────────────────────────────

export class MessageRouter {
  private watcher: AsyncTaskWatcher | null = null;

  constructor(
    private agents: AgentRegistry,
    private sessions: SessionManager,
    private context: ContextBuilder,
    private spawner: CCSpawner,
    private bindings: BindingConfig[],
  ) {}

  /**
   * Set the async task watcher (called after watcher is created in daemon).
   */
  setWatcher(watcher: AsyncTaskWatcher): void {
    this.watcher = watcher;
  }

  /**
   * Resolve which agent handles a message based on bindings.
   * Given (gateway, channelId), find the matching binding and return binding.agent.
   */
  resolveAgent(gateway: string, channelId: string): string | undefined {
    const binding = this.bindings.find(
      (b) => b.gateway === gateway && b.channel === channelId,
    );
    return binding?.agent;
  }

  /**
   * Resolve agent by gateway + bot ID (fallback for gateways like Slack
   * where DM channel IDs are dynamic and won't match a static binding).
   */
  resolveAgentByBot(gateway: string, botId: string): string | undefined {
    const binding = this.bindings.find(
      (b) => b.gateway === gateway && b.bot === botId,
    );
    return binding?.agent;
  }

  /**
   * Full message dispatch pipeline.
   *
   * 1. Look up agent config from registry
   * 2. Short-circuit trivial messages (thanks, ok, etc.)
   * 3. Derive session key: {agentId}:{gateway}:{channel}
   * 4. Get or create session
   * 5. Append user message to session
   * 6. Build context
   * 7. Spawn claude with streaming (or batch if no onChunk)
   * 8. Append assistant response to session (or error on failure)
   * 9. Return response text
   *
   * When `onChunk` is provided, uses the streaming spawner so callers
   * (Discord, Slack) can relay incremental text to the user in real time.
   */
  async route(
    message: IncomingMessage,
    onChunk?: StreamCallback,
  ): Promise<string> {
    const agentId = message.to.agent;

    // 1. Get agent config
    const agent = this.agents.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent "${agentId}" not found in registry`);
    }

    // 2. Short-circuit trivial messages
    if (TRIVIAL_PATTERN.test(message.content.trim())) {
      const reply = pickTrivialReply();
      // Still persist to session for continuity
      const sessionKey = this.sessions.getOrCreateSession(
        agentId,
        message.from.gateway,
        message.from.channel,
      );
      await this.sessions.appendMessage(agentId, sessionKey, {
        role: "user",
        content: message.content,
        ts: Date.now(),
        source: message.from.gateway,
        sourceUser: message.from.user,
        sourceMessageId: message.from.messageId,
      });
      await this.sessions.appendMessage(agentId, sessionKey, {
        role: "assistant",
        content: reply,
        ts: Date.now(),
        tokens: { in: 0, out: 0 },
      });
      return reply;
    }

    // 3. Derive session key
    const sessionKey = this.sessions.getOrCreateSession(
      agentId,
      message.from.gateway,
      message.from.channel,
    );

    // 4. Append user message to session
    await this.sessions.appendMessage(agentId, sessionKey, {
      role: "user",
      content: message.content,
      ts: Date.now(),
      source: message.from.gateway,
      sourceUser: message.from.user,
      sourceMessageId: message.from.messageId,
    });

    // 5. Download attachments (if any)
    //    Images  → base64 in-memory, passed as content blocks (no Read-tool round-trip)
    //    Other   → saved to temp dir so Claude can read them via the Read tool
    let attachmentDir: string | undefined;
    let messageContent = message.content;
    const images: ImageInput[] = [];

    if (message.attachments.length > 0) {
      const result = await this.downloadAttachments(message.attachments);
      attachmentDir = result.dir;
      images.push(...result.images);

      if (result.filePaths.length > 0) {
        const fileList = result.filePaths
          .map((p) => `  - ${p}`)
          .join("\n");
        messageContent += `\n\n[Attached files — use the Read tool to view them]\n${fileList}`;
      }

      if (result.rejected.length > 0) {
        const rejectedList = result.rejected.join(", ");
        messageContent += `\n\n[Rejected attachments (blocked file type): ${rejectedList}]`;
      }
    }

    // 6. Build context
    const systemPrompt = await this.context.build(agentId, sessionKey);

    // 7. Triage: sync or async?
    // Skip async triage for non-interactive gateways (bitbucket, jira) —
    // tmux interactive mode requires a trusted workspace prompt which
    // cannot be answered in headless mode. Use sync + long timeout instead.
    const interactiveGateways = new Set(["slack", "discord"]);
    const allowAsync = interactiveGateways.has(message.from.gateway);

    if (this.watcher && allowAsync) {
      const triageResult = await this.spawner.triage(messageContent);

      if (triageResult === "async") {
        logger.info(`router: async triage for agent=${agentId}, dispatching to tmux`);

        const asyncResult = await this.spawner.spawnAsync({
          workspace: agent.workspace,
          message: messageContent,
          systemPrompt,
          model: agent.model,
          agentId,
          ccgHome: getCcgHome(),
        });

        // Find the bot ID from the binding for this agent + gateway
        const binding = this.bindings.find(
          (b) => b.agent === agentId && b.gateway === message.from.gateway,
        );
        const botId = binding?.bot ?? agentId;

        // Register with watcher
        this.watcher.register({
          sessionName: asyncResult.sessionName,
          taskDir: asyncResult.taskDir,
          agentId,
          gateway: message.from.gateway,
          channel: message.from.channel,
          botId,
          startedAt: Date.now(),
        });

        // Append placeholder to session and return immediately
        const placeholder = `[async] Task dispatched to tmux session \`${asyncResult.sessionName}\`. I'll post the result here when done.`;
        await this.sessions.appendMessage(agentId, sessionKey, {
          role: "assistant",
          content: placeholder,
          ts: Date.now(),
          tokens: { in: 0, out: 0 },
        });

        // Clean up attachment temp dir
        if (attachmentDir) {
          rm(attachmentDir, { recursive: true, force: true }).catch(() => {});
        }

        return placeholder;
      }
    }

    // 8. Spawn claude (sync path)
    const spawnOptions = {
      workspace: agent.workspace,
      message: messageContent,
      systemPrompt,
      model: agent.model,
      allowedTools: agent.allowedTools,
      ...(agent.timeoutMs ? { timeoutMs: agent.timeoutMs } : {}),
      ...(images.length > 0 ? { images } : {}),
    };

    const result = onChunk
      ? await this.spawner.spawnStreaming(spawnOptions, onChunk)
      : await this.spawner.spawn(spawnOptions);

    // 9. Clean up attachment temp dir
    if (attachmentDir) {
      rm(attachmentDir, { recursive: true, force: true }).catch(() => {});
    }

    // 10. Handle failure: throw without persisting errors to session history.
    // Error responses pollute conversation context and waste tokens on
    // subsequent requests — the user already sees the error in Discord/Slack.
    if (result.exitCode !== 0) {
      const isTimeout = result.exitCode === 124;
      const stderrHint = result.stderr ? `\n\nDetails: ${result.stderr.slice(0, 500)}` : "";
      const errorContent = isTimeout
        ? "The task timed out — no activity was detected for over 15 minutes. Try breaking it into smaller steps."
        : (result.response || `Spawner failed with exit code ${result.exitCode}`) + stderrHint;
      throw new Error(errorContent);
    }

    // 11. Append assistant response to session
    await this.sessions.appendMessage(agentId, sessionKey, {
      role: "assistant",
      content: result.response,
      ts: Date.now(),
      tokens: result.tokensEstimate,
    });

    // 12. Return response text (guard against empty responses)
    return result.response.trim() || "(no response)";
  }

  /**
   * Add a binding at runtime.
   */
  addBinding(binding: BindingConfig): void {
    this.bindings.push(binding);
  }

  /**
   * Get all bindings for a given agent.
   */
  getBindingsForAgent(agentId: string): BindingConfig[] {
    return this.bindings.filter((b) => b.agent === agentId);
  }

  /**
   * Get the primary (first) binding for an agent.
   */
  getPrimaryBinding(agentId: string): BindingConfig | undefined {
    return this.bindings.find((b) => b.agent === agentId);
  }

  /**
   * Download attachments, separating images (kept as base64 in-memory)
   * from other files (saved to a temp directory for Read-tool access).
   * Rejects blocked file types (executables, archives, etc.).
   */
  private async downloadAttachments(
    attachments: Attachment[],
  ): Promise<{ dir: string; filePaths: string[]; images: ImageInput[]; rejected: string[] }> {
    const dir = join(tmpdir(), `ccg-attach-${Date.now()}`);
    const filePaths: string[] = [];
    const images: ImageInput[] = [];
    const rejected: string[] = [];
    let dirCreated = false;

    for (const att of attachments) {
      if (!att.url && !att.data) continue;

      const filename = att.filename || "attachment";

      if (isBlockedAttachment(att.type, filename)) {
        rejected.push(filename);
        continue;
      }

      try {
        // Use pre-downloaded data if available, otherwise fetch from URL
        let buffer: Buffer;
        if (att.data) {
          buffer = att.data;
        } else {
          const resp = await fetch(att.url!);
          if (!resp.ok) continue;
          buffer = Buffer.from(await resp.arrayBuffer());
        }

        if (att.type.startsWith("image/")) {
          images.push({
            base64: buffer.toString("base64"),
            mediaType: att.type,
          });
        } else {
          if (!dirCreated) {
            await mkdir(dir, { recursive: true });
            dirCreated = true;
          }
          const filePath = join(dir, filename);
          await writeFile(filePath, buffer);
          filePaths.push(filePath);
        }
      } catch {
        // Skip failed downloads
      }
    }

    return { dir, filePaths, images, rejected };
  }
}

// ── Attachment filtering ──────────────────────────────────────────────────

/** MIME types that are never allowed through. */
const BLOCKED_MIME_PREFIXES = [
  "application/x-executable",
  "application/x-msdos-program",
  "application/x-msdownload",
  "application/x-sharedlib",
  "application/x-dosexec",
  "application/vnd.microsoft.portable-executable",
];

const BLOCKED_MIME_EXACT = new Set([
  "application/x-sh",
  "application/x-csh",
  "application/x-bat",
  "application/x-msi",
  "application/java-archive",
  "application/x-rar-compressed",
  "application/x-7z-compressed",
  "application/x-tar",
  "application/gzip",
  "application/zip",
  "application/x-bzip2",
  "application/x-xz",
  "application/x-iso9660-image",
  "application/x-apple-diskimage",
  "application/vnd.debian.binary-package",
  "application/x-rpm",
]);

/** File extensions that are never allowed through (lowercase, with dot). */
const BLOCKED_EXTENSIONS = new Set([
  // Executables & scripts
  ".exe", ".bat", ".cmd", ".com", ".msi", ".scr", ".pif",
  ".sh", ".bash", ".csh", ".ksh", ".zsh",
  ".ps1", ".psm1", ".psd1", ".vbs", ".vbe", ".wsf", ".wsh",
  // Compiled / bytecode
  ".dll", ".so", ".dylib", ".sys", ".drv", ".o", ".obj",
  ".class", ".jar", ".war", ".ear",
  // Archives
  ".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z",
  ".rar", ".iso", ".dmg", ".img",
  // Packages
  ".deb", ".rpm", ".apk", ".snap", ".flatpak",
  ".whl", ".gem", ".nupkg",
]);

/** Returns true if the attachment should be rejected. */
export function isBlockedAttachment(mimeType: string, filename: string): boolean {
  const mime = mimeType.toLowerCase();

  if (BLOCKED_MIME_EXACT.has(mime)) return true;
  if (BLOCKED_MIME_PREFIXES.some((p) => mime.startsWith(p))) return true;

  const ext = filename.lastIndexOf(".") >= 0
    ? filename.slice(filename.lastIndexOf(".")).toLowerCase()
    : "";
  if (ext && BLOCKED_EXTENSIONS.has(ext)) return true;

  return false;
}
