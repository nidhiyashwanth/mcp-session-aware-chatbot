// src/backend-server.ts
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolResult,
  TextContent,
} from "@modelcontextprotocol/sdk/types.js";
// Removed OpenAI Chat Completions imports
import * as dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import {
  WebSocketMessage,
  StoredChatMessage,
} from "./types.js"; // Removed ChatMessageForOpenAI
import fetch from "node-fetch";
// Removed spawn import as it wasn't used directly in the provided snippets,
// but StdioClientTransport uses it internally. Keep if needed elsewhere.
// import { spawn, ChildProcessWithoutNullStreams } from "child_process";

dotenv.config();

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Use the Realtime model for session creation AND direct interaction
const REALTIME_MODEL = "gpt-4o-mini-realtime-preview-2024-12-17";

if (!OPENAI_API_KEY) {
  console.error("[Backend] ERROR: OPENAI_API_KEY environment variable not set.");
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.static(path.join(__dirname, "..", "public")));

// --- Helper Functions (Unchanged) ---
function extractTextFromResult(result: CallToolResult | null): string | null {
  if (!result) {
    console.error("[Backend MCP Helper] Null result.");
    return null;
  }
  if (result.isError) {
    const errTxt =
      (result.content?.[0] as TextContent)?.text || "Unknown error";
    console.error(`[Backend MCP Helper] Tool fail: ${errTxt}`);
    return null;
  }
  if (
    !result.content ||
    result.content.length === 0 ||
    result.content[0]?.type !== "text"
  ) {
    // It's possible for successful tool calls to have non-text content or be empty
    // Log differently or return a specific marker if needed.
    console.log("[Backend MCP Helper] Tool success, but no text content:", JSON.stringify(result));
    // Return null for now, assuming text is expected for confirmation messages.
    return null;
  }
  return (result.content[0] as TextContent).text;
}

function parseTranscript(
  jsonString: string | null
): StoredChatMessage[] | null {
  if (!jsonString) {
    console.error("[Backend MCP Helper] Cannot parse null transcript.");
    return null;
  }
  try {
    const t = JSON.parse(jsonString);
    if (
      Array.isArray(t) &&
      t.every(
        (m) =>
          m &&
          typeof m.role === "string" &&
          (m.role === "user" ||
            m.role === "assistant" ||
            m.role === "system") &&
          typeof m.content === "string"
      )
    ) {
      return t as StoredChatMessage[];
    }
    console.error("[Backend MCP Helper] Invalid StoredChatMessage[] format:", t);
    return null;
  } catch (e) {
    console.error(
      "[Backend MCP Helper] Failed parse transcript JSON:",
      e,
      "\nReceived:",
      jsonString
    );
    return null;
  }
}

// Endpoint /session-token (Ensure create_response is true/default)
app.get("/session-token", async (req, res) => {
  console.log("[Backend] Requesting session token...");
  try {
    const responsePayload = {
      model: REALTIME_MODEL, // Use the realtime model
      voice: "alloy",
      modalities: ["audio", "text"], // Keep text to get transcripts
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
      input_audio_transcription: { model: "gpt-4o-mini-transcribe" },
      // Let the Realtime API handle response generation directly
      turn_detection: {
        type: "server_vad",
        create_response: true, // This is crucial for the Realtime-Only flow
        silence_duration_ms: 500, // Adjust as needed
        // interrupt_response: true, // Optional: Enable if you want user barge-in
      },
      // instructions: "You are helpful and concise.", // Optional system prompt
    };

    console.log("[Backend] Sending payload to /v1/realtime/sessions:", JSON.stringify(responsePayload, null, 2));

    const r = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(responsePayload),
    });

    if (!r.ok) {
      const e = await r.text();
      console.error(`[Backend] OpenAI API Error (${r.status}) creating session: ${e}`);
      throw new Error(`API fail: ${r.status}`);
    }
    const d: any = await r.json();
    console.log("[Backend] Got session token object:", d);
    if (!d.client_secret?.value) {
       console.error("[Backend] Invalid session response - missing client_secret.value", d);
       throw new Error("Invalid token response format.");
    }
    res.json(d); // Send the full object back
  } catch (e: any) {
    console.error("[Backend] Error getting token:", e);
    res.status(500).json({ error: e.message || "Failed token create." });
  }
});


// Start HTTP server (Unchanged)
const server = app.listen(PORT, () => {
  console.log(`[Backend] HTTP on ${PORT}`);
  console.log(`[Backend] Frontend at http://localhost:${PORT}`);
});

// --- WebSocket Server Setup ---
const wss = new WebSocketServer({ server });

interface ConnectionState {
  mcpClient: McpClient;
  mcpTransport: StdioClientTransport;
  sessionId: string | null;
  isAlive: boolean;
}
const connections = new Map<WebSocket, ConnectionState>();

wss.on("connection", (ws) => {
  console.log("[Backend] WebSocket client connected.");
  let mcpClientInstance: McpClient | null = null;
  let mcpTransportInstance: StdioClientTransport | null = null;
  let sessionIdForConnection: string | null = null;
  let isAlive = true;

  // --- MCP Client/Transport Setup ---
  try {
    const mcpServerPath = path.join(__dirname, "chatbot-server.js"); // Your internal MCP server
    const serverParams: StdioServerParameters = {
      command: "node",
      args: [mcpServerPath],
      stderr: "pipe", // Capture stderr from the MCP server process
    };
    mcpTransportInstance = new StdioClientTransport(serverParams);

    mcpTransportInstance.stderr?.on("data", (data) => {
      console.error(`[MCP Server STDERR]: ${data.toString().trim()}`);
    });

    mcpClientInstance = new McpClient(
      { name: "backend-mcp-client", version: "1.0.0" },
      {} // Default capabilities for the backend's client
    );

    mcpClientInstance
      .connect(mcpTransportInstance)
      .then(() => {
        console.log("[Backend] Connected to internal MCP server (chatbot-server.js).");
        if (!mcpClientInstance) throw new Error("MCP client lost after connect");
        // Call 'start_session' on your internal MCP server
        return mcpClientInstance.callTool({
          name: "start_session",
          arguments: {},
        }) as Promise<CallToolResult | null>;
      })
      .then((startResult) => {
        sessionIdForConnection = extractTextFromResult(startResult);
        if (!sessionIdForConnection || !mcpClientInstance || !mcpTransportInstance) {
          throw new Error("Failed MCP session init with internal server.");
        }
        // Store the state associated with this WebSocket connection
        connections.set(ws, {
          mcpClient: mcpClientInstance,
          mcpTransport: mcpTransportInstance,
          sessionId: sessionIdForConnection,
          isAlive: true,
        });
        // Send the session ID back to the frontend client
        const sessionMsg: WebSocketMessage = {
          type: "sessionId",
          sessionId: sessionIdForConnection,
        };
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(sessionMsg));
        }
        console.log(`[Backend] Sent internal MCP session ID ${sessionIdForConnection} to frontend client.`);
      })
      .catch((err) => {
        console.error("[Backend] MCP client setup/start error:", err);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "error", message: "Backend internal server init fail." }));
          ws.close();
        }
        mcpTransportInstance?.close().catch((e) => console.error("Error closing transport on setup fail", e));
      });
  } catch (transportError) {
    console.error("[Backend] Error creating MCP transport:", transportError);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "error", message: "Backend setup error." }));
      ws.close();
    }
  }

  // --- WebSocket Message Handler ---
  ws.on("message", async (message) => {
    const messageString = message.toString();
    console.log(`[BACKEND] Received WebSocket message raw: "${messageString.substring(0, 200)}..."`);

    const connectionState = connections.get(ws);
    const sessionId = connectionState?.sessionId || 'UNKNOWN_SESSION'; // Get session ID safely
    console.log(`[BACKEND] [${sessionId}] Processing WebSocket message.`);

    if (!connectionState || !connectionState.sessionId) {
      console.error(`[BACKEND] [${sessionId}] WS message for inactive/unknown session.`);
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "error", message: "Backend session inactive." }));
      return;
    }

    const { mcpClient: internalMcpClient } = connectionState; // Use the client connected to chatbot-server.js
    let data: WebSocketMessage;

    try {
        data = JSON.parse(messageString);
    } catch (e) {
        console.error(`[BACKEND] [${sessionId}] Bad WS message JSON:`, e);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "error", message: "Invalid JSON format." }));
        return;
    }

    // --- Handle User Transcript Submission (STORAGE ONLY) ---
    if (data.type === "user_transcript" && data.content && sessionId) {
      console.log(`[BACKEND] [${sessionId}] USER_TRANSCRIPT_RECEIVED (for storage): "${data.content}"`);
      try {
        // Store user message via internal MCP server
        const storeUserRes = (await internalMcpClient.callTool({
          name: "add_message",
          arguments: { sessionId, role: "user", content: data.content },
        })) as CallToolResult | null;

        if (extractTextFromResult(storeUserRes) === null) {
          console.warn(`[BACKEND] [${sessionId}] MCP server (chatbot-server.js) did not confirm storing user message.`);
        } else {
          console.log(`[BACKEND] [${sessionId}] User message stored via internal MCP server.`);
        }
        // NO CALL TO CHAT COMPLETIONS HERE
      } catch (error) {
        console.error(`[BACKEND] [${sessionId}] Error storing user transcript via internal MCP server:`, error);
      }
    }
    // --- Handle Assistant Transcript Submission (for storage) ---
    else if (data.type === "store_assistant_transcript" && data.content && sessionId) {
      console.log(`[BACKEND] [${sessionId}] ASSISTANT_TRANSCRIPT_RECEIVED (for storage): "${data.content.substring(0,100)}..."`);
      try {
         // Store assistant message via internal MCP server
         const storeAsstRes = (await internalMcpClient.callTool({
            name: "add_message",
            arguments: {
                sessionId,
                role: "assistant",
                content: data.content,
            },
        })) as CallToolResult | null;
         if (extractTextFromResult(storeAsstRes) === null) {
            console.warn(`[BACKEND] [${sessionId}] MCP server (chatbot-server.js) did not confirm storing assistant message.`);
        } else {
             console.log(`[BACKEND] [${sessionId}] Assistant message stored via internal MCP server.`);
         }
      } catch (error) {
        console.error(`[BACKEND] [${sessionId}] Error storing assistant transcript via internal MCP server:`, error);
      }
    }
    // --- Handle other message types if needed ---
    else {
      console.warn(`[BACKEND] [${sessionId}] Received unhandled WebSocket message type from frontend:`, data.type);
    }
  });

  // --- WebSocket Close/Error/Heartbeat (Unchanged) ---
  ws.on("close", async () => {
    console.log("[Backend] WS client disconnected.");
    const cs = connections.get(ws);
    if (cs) {
      const { mcpClient: c, mcpTransport: t, sessionId: sid } = cs;
      connections.delete(ws);
      console.log(`[Backend] Cleanup internal MCP session ${sid}...`);
      try {
        if (sid) {
          // Attempt to end session on the internal MCP server
          await Promise.race([
            c.callTool({ name: "end_session", arguments: { sessionId: sid } }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("end_session timeout")), 2000)
            ),
          ]).catch(e => console.warn(`[Backend] [${sid}] MCP end_session call failed or timed out:`, e)); // Catch potential error/timeout
        }
        await c.close();
        console.log("[Backend] Internal MCP Client closed.");
        await t.close(); // This should terminate the node process for chatbot-server.js
        console.log("[Backend] Internal MCP Transport closed.");
      } catch (cerr) {
        console.error("[Backend] Internal MCP cleanup error:", cerr);
      }
    } else {
        console.log("[Backend] WS client disconnected but no connection state found.");
    }
  });

  ws.on("error", (error) => {
    console.error("[Backend] WS error:", error);
    const cs = connections.get(ws);
    if (cs) {
      cs.mcpTransport?.close().catch((e) => console.error("Err closing transport on WS error", e));
      connections.delete(ws); // Clean up state on error
    }
  });

  ws.on("pong", () => {
      const state = connections.get(ws);
      if (state) state.isAlive = true;
  });
});

// Heartbeat (Unchanged)
const interval = setInterval(() => {
  connections.forEach((state, ws) => {
    if (!state.isAlive) {
      console.log(`[Backend] Heartbeat fail for session ${state.sessionId || 'unknown'}. Terminating WS.`);
      ws.terminate(); // Force close
      // Cleanup should happen in the 'close' event handler now
      return; // Skip pinging this one
    }
    state.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on("close", () => {
  clearInterval(interval);
  console.log("[Backend] WS Server closed.");
});

console.log("[Backend] WebSocket server initialized (Realtime API Only Flow).");