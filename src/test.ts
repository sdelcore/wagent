import { SandboxAgent } from "sandbox-agent";
import { local } from "sandbox-agent/local";

async function main() {
  console.log("Starting sandbox-agent in embedded mode...\n");

  const sdk = await SandboxAgent.start({
    sandbox: local({ log: "inherit" }),
  });

  try {
    // List available agents
    const agents = await sdk.listAgents();
    console.log(
      "Available agents:",
      agents.agents.map((a) => a.id)
    );

    // Create a session with Claude in this project dir
    const session = await sdk.createSession({
      agent: "claude",
      cwd: process.cwd(),
    });

    console.log(`\nSession created: ${session.id}`);
    console.log(`Agent session ID: ${session.agentSessionId}\n`);

    // Auto-approve permissions for this test
    session.onPermissionRequest((req) => {
      console.log(`[permission] ${req.toolCall.title ?? req.toolCall.toolCallId} → auto-approved`);
      void session.respondPermission(req.id, "always");
    });

    // Dump raw events so we can see the actual shape
    session.onEvent((event) => {
      console.log("[event]", JSON.stringify(event, null, 2));
    });

    // Send a simple prompt
    console.log("Sending prompt: 'What files are in this directory? Just list them briefly.'\n");
    console.log("---");

    const response = await session.prompt([
      { type: "text", text: "What files are in this directory? Just list them briefly." },
    ]);

    console.log("\n---");
    console.log(`\nDone. Stop reason: ${response.stopReason}`);

    // List sessions to verify persistence
    const sessions = await sdk.listSessions();
    console.log(`\nTotal sessions: ${sessions.items.length}`);
    for (const s of sessions.items) {
      console.log(`  - ${s.id} (agent: ${s.agent}, created: ${s.createdAt})`);
    }
  } finally {
    await sdk.dispose();
    console.log("\nCleaned up.");
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
