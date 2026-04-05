import { createInterface } from "node:readline";
import type { AgentRegistry } from "./agents.js";
import type { SessionManager } from "./sessions.js";
import type { ContextBuilder } from "./context.js";
import type { CCSpawner } from "./spawner.js";

// ── Chat REPL ──────────────────────────────────────────────────────────────

/**
 * Build the session key for CLI chat sessions.
 * Format: {agentId}:cli:manual
 */
export function buildChatSessionKey(agentId: string): string {
  return `${agentId}:cli:manual`;
}

/**
 * Start an interactive chat REPL with the specified agent.
 */
export async function startChat(
  agentId: string,
  agents: AgentRegistry,
  sessions: SessionManager,
  context: ContextBuilder,
  spawner: CCSpawner,
): Promise<void> {
  // 1. Validate agent exists
  const agent = agents.getAgent(agentId);
  if (!agent) {
    throw new Error(`Agent "${agentId}" not found`);
  }

  // 2. Create session key
  const sessionKey = buildChatSessionKey(agentId);

  console.log(`Chat with ${agent.name} (${agentId}) — model: ${agent.model}`);
  console.log(`Session: ${sessionKey}`);
  console.log(`Commands: /new or /reset (reset session), /quit or /exit (exit)`);
  console.log(`Tip: end a line with \\ for multi-line input`);
  console.log();

  // 3. REPL loop
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (): Promise<string | null> =>
    new Promise((resolve) => {
      rl.question("you> ", (answer) => resolve(answer));
      rl.once("close", () => resolve(null));
    });

  try {
    while (true) {
      const firstLine = await prompt();

      // EOF (Ctrl+D)
      if (firstLine === null) {
        console.log();
        break;
      }

      // Support multi-line input: if line ends with \, keep reading
      let input = firstLine;
      while (input.endsWith("\\")) {
        input = input.slice(0, -1) + "\n";
        const continuation = await prompt();
        if (continuation === null) break;
        input += continuation;
      }

      const trimmed = input.trim();

      // Skip empty input
      if (trimmed === "") continue;

      // Handle commands
      if (trimmed === "/quit" || trimmed === "/exit") {
        break;
      }

      if (trimmed === "/new" || trimmed === "/reset") {
        await sessions.resetSession(agentId, sessionKey);
        console.log("Session reset.\n");
        continue;
      }

      // Append user message to session
      await sessions.appendMessage(agentId, sessionKey, {
        role: "user",
        content: trimmed,
        ts: Date.now(),
        source: "cli",
        sourceUser: "user",
      });

      // Build context
      const contextStr = await context.build(agentId, sessionKey);

      // Spawn claude --print
      const result = await spawner.spawn({
        workspace: agent.workspace,
        message: trimmed,
        systemPrompt: contextStr,
        model: agent.model,
        allowedTools: agent.allowedTools,
      });

      // Print response
      console.log();
      console.log(result.response);
      console.log();

      // Append assistant response to session
      await sessions.appendMessage(agentId, sessionKey, {
        role: "assistant",
        content: result.response,
        ts: Date.now(),
        source: "cli",
        tokens: result.tokensEstimate,
      });

      // Show token usage estimate
      console.log(
        `  [tokens ~ in: ${result.tokensEstimate.in}, out: ${result.tokensEstimate.out}]`,
      );
      console.log();
    }
  } finally {
    rl.close();
  }
}
