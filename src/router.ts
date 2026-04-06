import type { AgentRegistry } from "./agents.js";
import type { AsyncTaskWatcher } from "./async-watcher.js";
import type { SessionManager } from "./sessions.js";
import type { ContextBuilder } from "./context.js";
import type { CCSpawner, ImageInput } from "./spawner.js";
import type { IncomingMessage, Attachment, BindingConfig } from "./types.js";
import { getCcgHome } from "./config.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── MessageRouter ─────────────────────────────────────────────────────────

export class MessageRouter {
  constructor(
    private agents: AgentRegistry,
    private sessions: SessionManager,
    private context: ContextBuilder,
    private spawner: CCSpawner,
    private bindings: BindingConfig[],
    private watcher?: AsyncTaskWatcher,
  ) {}

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
   * 2. Derive session key: {agentId}:{gateway}:{channel}
   * 3. Get or create session
   * 4. Append user message to session
   * 5. Build context
   * 6. Spawn claude --print
   * 7. Append assistant response to session (or error on failure)
   * 8. Return response text
   */
  async route(message: IncomingMessage): Promise<string> {
    const agentId = message.to.agent;

    // 1. Get agent config
    const agent = this.agents.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent "${agentId}" not found in registry`);
    }

    // 2. Derive session key
    const sessionKey = this.sessions.getOrCreateSession(
      agentId,
      message.from.gateway,
      message.from.channel,
    );

    // 3. Append user message to session
    await this.sessions.appendMessage(agentId, sessionKey, {
      role: "user",
      content: message.content,
      ts: Date.now(),
      source: message.from.gateway,
      sourceUser: message.from.user,
      sourceMessageId: message.from.messageId,
    });

    // 4. Download attachments (if any)
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

    // 5. Build context
    const systemPrompt = await this.context.build(agentId, sessionKey);

    // 5.5 Triage: should this run async?
    const mode = this.watcher
      ? await this.spawner.triage(messageContent, agent.model)
      : ("sync" as const);

    if (mode === "async") {
      // For async tasks with images: save images to temp files in the
      // workspace so Claude Code can read them via the Read tool.
      let asyncMessage = messageContent;
      let asyncAttachDir: string | undefined;

      if (images.length > 0) {
        const dir = join(agent.workspace, `.ccg-attachments-${Date.now()}`);
        await mkdir(dir, { recursive: true });
        asyncAttachDir = dir;

        const paths: string[] = [];
        for (let i = 0; i < images.length; i++) {
          const ext = images[i].mediaType.split("/")[1] || "png";
          const filePath = join(dir, `image-${i}.${ext}`);
          await writeFile(filePath, Buffer.from(images[i].base64, "base64"));
          paths.push(filePath);
        }
        const fileList = paths.map((p) => `  - ${p}`).join("\n");
        asyncMessage += `\n\n[Attached images — use the Read tool to view them]\n${fileList}`;
      }

      const { sessionName, taskDir } = await this.spawner.spawnAsync({
        workspace: agent.workspace,
        message: asyncMessage,
        systemPrompt,
        model: agent.model,
        ccgHome: getCcgHome(),
        agentId,
      });

      // Register with watcher
      const binding = this.bindings.find((b) => b.agent === agentId);
      this.watcher!.register({
        sessionName,
        taskDir,
        agentId,
        gateway: message.from.gateway,
        channel: message.from.channel,
        botId: binding?.bot ?? agentId,
        sessionKey,
        workspace: agent.workspace,
        startedAt: Date.now(),
      });

      const placeholder = `On it — working on this in the background. I'll get back to you when it's done. (tmux: \`${sessionName}\`)`;
      await this.sessions.appendMessage(agentId, sessionKey, {
        role: "assistant",
        content: placeholder,
        ts: Date.now(),
        tokens: { in: 0, out: 0 },
      });

      return placeholder;
    }

    // 6. Spawn claude --print (sync path — unchanged)
    const result = await this.spawner.spawn({
      workspace: agent.workspace,
      message: messageContent,
      systemPrompt,
      model: agent.model,
      allowedTools: agent.allowedTools,
      ...(agent.timeoutMs ? { timeoutMs: agent.timeoutMs } : {}),
      ...(images.length > 0 ? { images } : {}),
    });

    // 7. Clean up attachment temp dir
    if (attachmentDir) {
      rm(attachmentDir, { recursive: true, force: true }).catch(() => {});
    }

    // 8. Handle failure: append error to session and throw
    if (result.exitCode !== 0) {
      const isTimeout = result.exitCode === 124;
      const stderrHint = result.stderr ? `\n\nDetails: ${result.stderr.slice(0, 500)}` : "";
      const errorContent = isTimeout
        ? "The task timed out — it took longer than the allowed time. Try breaking it into smaller steps, or increase the agent's `timeoutMs` setting."
        : (result.response || `Spawner failed with exit code ${result.exitCode}`) + stderrHint;
      await this.sessions.appendMessage(agentId, sessionKey, {
        role: "assistant",
        content: `[error] ${errorContent}`,
        ts: Date.now(),
        tokens: result.tokensEstimate,
      });
      throw new Error(errorContent);
    }

    // 9. Append assistant response to session
    await this.sessions.appendMessage(agentId, sessionKey, {
      role: "assistant",
      content: result.response,
      ts: Date.now(),
      tokens: result.tokensEstimate,
    });

    // 10. Return response text
    return result.response;
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
