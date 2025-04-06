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
import OpenAI from "openai"; // Now needed for Chat Completions
import {
  ChatCompletionTool,
  ChatCompletionMessageParam,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions"; // Needed for types
import * as dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import {
  WebSocketMessage,
  StoredChatMessage,
  ChatMessageForOpenAI,
} from "./types.js"; // Import types
import fetch from "node-fetch";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";

dotenv.config();

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL_FOR_TOKEN = "gpt-4o-mini-realtime-preview-2024-12-17"; // For /sessions endpoint
const CHAT_COMPLETIONS_MODEL = "gpt-4o-mini-2024-07-18"; // For generating responses

if (!OPENAI_API_KEY) {
  /*...*/ process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.static(path.join(__dirname, "..", "public")));

// --- OpenAI Chat Completions Client ---
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- Tool Definitions for Chat Completions AI ---
const availableToolsForChatCompletion: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "add_system_note",
      description: "Adds a SYSTEM message/note to the transcript.",
      parameters: {
        type: "object",
        properties: {
          note: { type: "string", description: "The system note content." },
        },
        required: ["note"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_sessions",
      description: "Lists stored session IDs.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "end_session",
      description: "Ends the current chat session.",
      parameters: { type: "object", properties: {} },
    },
  },
];
// ----------------------------------------

// Helper: Extract Text (Unchanged)
function extractTextFromResult(result: CallToolResult | null): string | null {
  /* ... */ if (!result) {
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
    console.error("[Backend MCP Helper] Bad format:", JSON.stringify(result));
    return null;
  }
  return (result.content[0] as TextContent).text;
}
// Helper: Parse Transcript (Unchanged)
function parseTranscript(
  jsonString: string | null
): StoredChatMessage[] | null {
  /* ... */ if (!jsonString) {
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
    console.error("[Backend MCP Helper] Invalid StoredChatMessage[]:", t);
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

// Endpoint /session-token (Unchanged)
app.get("/session-token", async (req, res) => {
  /* ... same as before ... */
  console.log("[Backend] Requesting session token...");
  try {
    const r = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: REALTIME_MODEL_FOR_TOKEN,
        voice: "alloy",
        modalities: ["audio", "text"],
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        input_audio_transcription: { model: "gpt-4o-mini-transcribe" },
      }),
    });
    if (!r.ok) {
      const e = await r.text();
      console.error(`[Backend] OpenAI API Error (${r.status}): ${e}`);
      throw new Error(`API fail: ${r.status}`);
    }
    const d: any = await r.json();
    console.log("[Backend] Got session token.");
    res.json(d);
  } catch (e) {
    console.error("[Backend] Error getting token:", e);
    res.status(500).json({ error: "Failed token create." });
  }
});

// Start HTTP server (Unchanged)
const server = app.listen(PORT, () => {
  /* ... */ console.log(`[Backend] HTTP on ${PORT}`);
  console.log(`[Backend] Frontend at http://localhost:${PORT}`);
});

// --- WebSocket Server Setup ---
const wss = new WebSocketServer({ server });

interface ConnectionState {
  mcpClient: McpClient;
  mcpTransport: StdioClientTransport; // Store transport for potential access (e.g., stderr)
  sessionId: string | null;
  isAlive: boolean;
  // No need to store mcpServerProcess here, transport manages it
}
const connections = new Map<WebSocket, ConnectionState>();

wss.on("connection", (ws) => {
  console.log("[Backend] WebSocket client connected.");
  let mcpClientInstance: McpClient | null = null;
  let mcpTransportInstance: StdioClientTransport | null = null;
  let sessionIdForConnection: string | null = null;
  let isAlive = true;

  try {
    const mcpServerPath = path.join(__dirname, "chatbot-server.js");
    const serverParams: StdioServerParameters = {
      command: "node",
      args: [mcpServerPath],
      stderr: "pipe",
    };
    mcpTransportInstance = new StdioClientTransport(serverParams);

    mcpTransportInstance.stderr?.on("data", (data) => {
      console.error(`[MCP Server STDERR]: ${data.toString().trim()}`);
    });
    // Note: StdioClientTransport doesn't expose 'error' or 'exit' events directly for the spawned process.
    // We rely on the transport's own error/close handling.

    mcpClientInstance = new McpClient(
      { name: "backend-mcp-client", version: "1.0.0" },
      {}
    );

    mcpClientInstance
      .connect(mcpTransportInstance)
      .then(() => {
        console.log("[Backend] Connected to internal MCP server.");
        if (!mcpClientInstance)
          throw new Error("MCP client lost after connect");
        return mcpClientInstance.callTool({
          name: "start_session",
          arguments: {},
        }) as Promise<CallToolResult | null>;
      })
      .then((startResult) => {
        sessionIdForConnection = extractTextFromResult(startResult);
        if (
          !sessionIdForConnection ||
          !mcpClientInstance ||
          !mcpTransportInstance
        ) {
          throw new Error("Failed MCP session init.");
        }
        connections.set(ws, {
          mcpClient: mcpClientInstance,
          mcpTransport: mcpTransportInstance,
          sessionId: sessionIdForConnection,
          isAlive: true,
        });
        const sessionMsg: WebSocketMessage = {
          type: "sessionId",
          sessionId: sessionIdForConnection,
        };
        ws.send(JSON.stringify(sessionMsg));
        console.log(
          `[Backend] Sent session ID ${sessionIdForConnection} to client.`
        );
      })
      .catch((err) => {
        console.error("[Backend] MCP client setup/start error:", err);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({ type: "error", message: "Backend init fail." })
          );
          ws.close();
        }
        mcpTransportInstance
          ?.close()
          .catch((e) =>
            console.error("Error closing transport on setup fail", e)
          );
      });
  } catch (transportError) {
    console.error("[Backend] Error creating MCP transport:", transportError);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({ type: "error", message: "Backend setup error." })
      );
      ws.close();
    }
  }

  // --- WebSocket Message Handler (NEW LOGIC) ---
  ws.on("message", async (message) => {
    console.log("[Backend] Received WS message:", message.toString());
    const connectionState = connections.get(ws);
    if (!connectionState || !connectionState.sessionId) {
      console.error("[Backend] WS message for inactive session.");
      if (ws.readyState === WebSocket.OPEN)
        ws.send(
          JSON.stringify({
            type: "error",
            message: "Backend session inactive.",
          })
        );
      return;
    }

    const { mcpClient: client, sessionId } = connectionState;
    let data: WebSocketMessage;

    try {
      data = JSON.parse(message.toString());
    } catch (e) {
      console.error("[Backend] Bad WS message:", e);
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: "error", message: "Invalid format." }));
      return;
    }

    // --- Handle User Transcript Submission ---
    if (data.type === "user_transcript" && data.content && sessionId) {
      console.log(
        `[Backend] Processing user transcript for session ${sessionId}: "${data.content.substring(
          0,
          50
        )}..."`
      );
      try {
        // 1. Store user message via MCP
        const storeUserRes = (await client.callTool({
          name: "add_message",
          arguments: { sessionId, role: "user", content: data.content },
        })) as CallToolResult | null;
        if (extractTextFromResult(storeUserRes) === null) {
          throw new Error("Failed to store user message via MCP.");
        }

        // 2. Get full transcript via MCP
        const transcriptRes = (await client.callTool({
          name: "get_transcript",
          arguments: { sessionId },
        })) as CallToolResult | null;
        const transcriptJson = extractTextFromResult(transcriptRes);
        const transcript = parseTranscript(transcriptJson); // Parses into StoredChatMessage[]

        if (!transcript) {
          throw new Error("Failed to retrieve or parse transcript via MCP.");
        }

        // 3. Call OpenAI Chat Completions (handle tools)
        let messagesForOpenAI: ChatMessageForOpenAI[] =
          transcript as ChatMessageForOpenAI[]; // Cast for OpenAI API
        let finalAssistantText: string | null = null;
        let shouldExitSession = false;

        // --- Loop to handle potential tool calls ---
        for (let i = 0; i < 5; i++) {
          // Limit tool call iterations
          console.log(`[Backend] Calling OpenAI (Turn ${i + 1})...`);
          const chatResponse = await openai.chat.completions.create({
            model: CHAT_COMPLETIONS_MODEL,
            messages: messagesForOpenAI,
            tools: availableToolsForChatCompletion,
            tool_choice: "auto",
          });

          const responseMessage = chatResponse.choices[0].message;
          messagesForOpenAI.push(responseMessage); // Add AI response (incl. tool calls) to local history

          if (
            responseMessage.tool_calls &&
            responseMessage.tool_calls.length > 0
          ) {
            console.log(
              `[Backend] AI requested tools:`,
              responseMessage.tool_calls.map((tc) => tc.function.name)
            );
            const toolResponses: ChatCompletionToolMessageParam[] = [];

            for (const toolCall of responseMessage.tool_calls) {
              const functionName = toolCall.function.name;
              let functionArgs = {};
              try {
                functionArgs = JSON.parse(toolCall.function.arguments);
              } catch (e) {
                console.error(`Bad JSON args for ${functionName}:`, e);
                toolResponses.push({
                  tool_call_id: toolCall.id,
                  role: "tool",
                  content: "Error: Invalid arguments.",
                });
                continue;
              }

              let toolResultContent = "Error: Tool execution failed.";
              let mcpToolResult: CallToolResult | null = null;

              try {
                console.log(
                  `[Backend] Executing MCP tool (internal): ${functionName}`,
                  functionArgs
                );
                if (functionName === "add_system_note") {
                  mcpToolResult = (await client.callTool({
                    name: "add_system_note",
                    arguments: {
                      sessionId,
                      note: (functionArgs as any)?.note ?? "",
                    },
                  })) as CallToolResult | null;
                } else if (functionName === "list_sessions") {
                  mcpToolResult = (await client.callTool({
                    name: "list_sessions",
                    arguments: {},
                  })) as CallToolResult | null;
                } else if (functionName === "end_session") {
                  mcpToolResult = (await client.callTool({
                    name: "end_session",
                    arguments: { sessionId },
                  })) as CallToolResult | null;
                  shouldExitSession = true; // Flag to exit after this turn
                } else {
                  console.error(
                    `[Backend] Unknown tool requested by AI: ${functionName}`
                  );
                  toolResultContent = `Error: Unknown tool '${functionName}' requested.`;
                  // Skip MCP call for unknown tool
                }

                if (mcpToolResult !== undefined) {
                  // Check if MCP call was attempted
                  const extracted = extractTextFromResult(mcpToolResult);
                  toolResultContent =
                    extracted ??
                    `Tool ${functionName} completed (no text result).`;
                }
              } catch (mcpErr) {
                console.error(
                  `[Backend] Error executing MCP tool ${functionName}:`,
                  mcpErr
                );
                toolResultContent = `Error: Failed to execute tool ${functionName}.`;
              }
              toolResponses.push({
                tool_call_id: toolCall.id,
                role: "tool",
                content: toolResultContent,
              });
              if (shouldExitSession) break; // Exit tool loop if ending session
            } // end for toolCall

            toolResponses.forEach((resp) => messagesForOpenAI.push(resp)); // Add tool results to local history

            if (shouldExitSession) {
              finalAssistantText =
                responseMessage.content ?? "Okay, ending the session now."; // Use any text AI gave before exit call
              break; // Exit the outer tool handling loop
            }
            // If not exiting, loop back to call OpenAI again with tool results
          } else {
            // No tool calls, this is the final response
            finalAssistantText = responseMessage.content;
            break; // Exit the tool handling loop
          }
        } // end tool handling loop (limited iterations)
        //-------------------------------------

        if (finalAssistantText === null && !shouldExitSession) {
          finalAssistantText =
            "I seem to have finished processing but have nothing more to say."; // Fallback
          console.warn(
            "[Backend] AI finished turn with tool calls but no final text content."
          );
        }

        // 4. Send final assistant text back to Frontend via WebSocket
        if (finalAssistantText !== null) {
          console.log(
            `[Backend] Sending assistant response to client: "${finalAssistantText.substring(
              0,
              50
            )}..."`
          );
          const assistantMsg: WebSocketMessage = {
            type: "assistant_response",
            content: finalAssistantText,
            sessionId,
          };
          ws.send(JSON.stringify(assistantMsg));

          // 5. Store final assistant message via MCP
          console.log(
            `[Backend] Storing assistant message for session ${sessionId}`
          );
          (await client.callTool({
            name: "add_message",
            arguments: {
              sessionId,
              role: "assistant",
              content: finalAssistantText,
            },
          })) as CallToolResult | null;
          // Log if storing assistant message failed?
        }

        // 6. Handle Session Exit if flagged
        if (shouldExitSession) {
          console.log(
            `[Backend] Instructing client to disconnect session ${sessionId}.`
          );
          if (ws.readyState === WebSocket.OPEN) {
            // Send a specific message or just close? Let's just close from backend.
            // ws.send(JSON.stringify({ type: 'status_update', message: 'Session ended by assistant.' }));
            ws.close(1000, "Session ended by assistant request."); // Close WS triggers cleanup
          }
        }
      } catch (error) {
        console.error(
          `[Backend] Error processing user transcript for session ${sessionId}:`,
          error
        );
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Failed to process message and get AI response.",
            })
          );
        }
      }
    } else {
      console.warn(
        "[Backend] Received unhandled WebSocket message type:",
        data.type
      );
    }
  });

  // --- WebSocket Close/Error/Heartbeat (Unchanged) ---
  ws.on("close", async () => {
    /* ... same cleanup logic using transport ... */
    console.log("[Backend] WS client disconnected.");
    const cs = connections.get(ws);
    if (cs) {
      const { mcpClient: c, mcpTransport: t, sessionId: sid } = cs;
      connections.delete(ws);
      console.log(`[Backend] Cleanup session ${sid}...`);
      try {
        if (sid) {
          await Promise.race([
            c.callTool({ name: "end_session", arguments: { sessionId: sid } }),
            new Promise((_, r) =>
              setTimeout(() => r(new Error("end_session timeout")), 2000)
            ),
          ]);
        }
        await c.close();
        console.log("[Backend] MCP Client closed.");
        await t.close();
        console.log("[Backend] MCP Transport closed.");
      } catch (cerr) {
        console.error("[Backend] MCP cleanup error:", cerr);
      }
    }
  });
  ws.on("error", (error) => {
    /* ... same cleanup logic using transport ... */ console.error(
      "[Backend] WS error:",
      error
    );
    const cs = connections.get(ws);
    if (cs) {
      cs.mcpTransport
        ?.close()
        .catch((e) => console.error("Err closing transport on WS error", e));
      connections.delete(ws);
    }
  });
  ws.on("pong", () => {
    /* ... same ... */ const s = connections.get(ws);
    if (s) s.isAlive = true;
  });
});

// Heartbeat (Unchanged)
const interval = setInterval(() => {
  /* ... same logic using transport ... */ connections.forEach((state, ws) => {
    if (!state.isAlive) {
      console.log("[Backend] Heartbeat fail. Terminating WS.");
      ws.terminate();
      state.mcpTransport
        ?.close()
        .catch((e) =>
          console.error("Err closing transport on heartbeat fail", e)
        );
      connections.delete(ws);
      return;
    }
    state.isAlive = false;
    ws.ping();
  });
}, 30000);
wss.on("close", () => {
  clearInterval(interval);
  console.log("[Backend] WS Server closed.");
});

console.log("[Backend] WebSocket server initialized.");
