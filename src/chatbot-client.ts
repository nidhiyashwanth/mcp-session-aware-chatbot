// src/chatbot-client.ts
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolResult,
  TextContent,
} from "@modelcontextprotocol/sdk/types.js";
import OpenAI from "openai";
import {
  ChatCompletionTool,
  // ChatCompletionMessageParam, // We'll use our specific type alias
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions";
import * as dotenv from "dotenv";
import readline from "readline/promises";
// --- FIX: Import the correct type ---
import { ChatMessageForOpenAI, StoredChatMessage } from "./types.js";
// ------------------------------------

dotenv.config();

// --- OpenAI Setup (Unchanged) ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
if (!process.env.OPENAI_API_KEY) {
  console.error("[Client] Error: OPENAI_API_KEY missing.");
  process.exit(1);
}
// --------------------------------

// --- Define Tools for OpenAI (Unchanged) ---
const availableTools: ChatCompletionTool[] = [
  /* ... same as before ... */
  {
    type: "function",
    function: {
      name: "add_system_note",
      description: "Adds a SYSTEM message...",
      parameters: {
        type: "object",
        properties: {
          note: { type: "string", description: "The system note." },
        },
        required: ["note"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_sessions",
      description: "Lists IDs of stored sessions.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "end_session",
      description: "Ends the current session.",
      parameters: { type: "object", properties: {} },
    },
  },
];
// -------------------------------------------

// --- MCP Client Setup (Unchanged) ---
const transport = new StdioClientTransport({
  command: "node",
  args: ["build/chatbot-server.js"],
});
const mcpClient = new McpClient(
  { name: "chatbot-cli-client-ai", version: "1.3.0" },
  {}
);
// ------------------------------------

// --- Helper Functions (Unchanged) ---
function extractTextFromResult(result: CallToolResult | null): string | null {
  /* ... same as before ... */
  if (!result) {
    console.error("[Client] Received null result.");
    return null;
  }
  if (result.isError) {
    const errTxt =
      (result.content?.[0] as TextContent)?.text || "Unknown server error";
    console.error(`[Client] Tool call failed: ${errTxt}`);
    return null;
  }
  if (
    !result.content ||
    result.content.length === 0 ||
    result.content[0]?.type !== "text"
  ) {
    console.error("[Client] Unexpected result format:", JSON.stringify(result));
    return null;
  }
  return (result.content[0] as TextContent).text;
}
function parseTranscript(
  jsonString: string | null
): StoredChatMessage[] | null {
  /* ... same as before ... */
  if (!jsonString) {
    console.error("[Client] Cannot parse null transcript.");
    return null;
  }
  try {
    const transcript = JSON.parse(jsonString);
    if (
      Array.isArray(transcript) &&
      transcript.every(
        (msg) =>
          msg &&
          typeof msg.role === "string" &&
          (msg.role === "user" ||
            msg.role === "assistant" ||
            msg.role === "system") &&
          typeof msg.content === "string"
      )
    ) {
      return transcript as StoredChatMessage[];
    }
    console.error("[Client] Invalid StoredChatMessage array:", transcript);
    return null;
  } catch (e) {
    console.error(
      "[Client] Failed parse transcript JSON:",
      e,
      "\nReceived:",
      jsonString
    );
    return null;
  }
}
// ------------------------------------

// --- Main Application Logic ---
async function main() {
  let sessionId: string | null = null;
  let isConnected = false;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log("[Client] Connecting to Chatbot Session MCP Server...");
    await mcpClient.connect(transport);
    isConnected = true;
    console.log("[Client] Connected successfully.");

    console.log("[Client] Starting new session...");
    const startResult = (await mcpClient.callTool({
      name: "start_session",
      arguments: {},
    })) as CallToolResult | null;
    sessionId = extractTextFromResult(startResult);

    if (!sessionId) {
      throw new Error("Failed to start session.");
    }
    console.log(`[Client] Session started with ID: ${sessionId}`);
    console.log("\nChatbot Ready. Ask the assistant to quit when finished.");

    // Main chat loop
    while (true) {
      const userInput = await rl.question("You: ");
      let storeUserMessage = true;

      // 1. Get transcript
      const transcriptResult = (await mcpClient.callTool({
        name: "get_transcript",
        arguments: { sessionId },
      })) as CallToolResult | null;
      const transcriptJson = extractTextFromResult(transcriptResult);
      // --- FIX: Use correct type for OpenAI ---
      const messagesForOpenAI: ChatMessageForOpenAI[] = (parseTranscript(
        transcriptJson
      ) ?? []) as ChatMessageForOpenAI[];
      // -----------------------------------------
      messagesForOpenAI.push({ role: "user", content: userInput });

      // 2. Call OpenAI
      console.log("[Client] Getting response from OpenAI...");
      try {
        let response = await openai.chat.completions.create({
          model: "gpt-4o-mini-2024-07-18",
          messages: messagesForOpenAI,
          tools: availableTools,
          tool_choice: "auto",
        });
        let message = response.choices[0].message;
        const toolCalls = message.tool_calls;
        let finalAssistantContent: string | null = message.content;
        let shouldExit = false;

        // Check if user message should be skipped
        if (toolCalls && toolCalls.length > 0 && !finalAssistantContent) {
          console.log(
            "[Client] User input interpreted as command, skipping storage."
          );
          storeUserMessage = false;
        }

        // Add user message (Conditional)
        if (storeUserMessage) {
          console.log("[Client] Storing user message...");
          const addUserResult = (await mcpClient.callTool({
            name: "add_message",
            arguments: { sessionId, role: "user", content: userInput },
          })) as CallToolResult | null;
          if (extractTextFromResult(addUserResult) === null) {
            console.error("[Client] Failed to add user message.");
            continue;
          }
        }

        // Tool Calling Loop
        if (toolCalls && toolCalls.length > 0) {
          console.log(
            "[Client] AI requested tools:",
            toolCalls.map((tc) => tc.function.name).join(", ")
          );
          messagesForOpenAI.push(message); // Add assistant's request to local history
          const toolResponses: ChatCompletionToolMessageParam[] = [];

          for (const toolCall of toolCalls) {
            /* ... same tool execution logic as before ... */
            const functionName = toolCall.function.name;
            let functionArgs = {};
            try {
              if (toolCall.function.arguments)
                functionArgs = JSON.parse(toolCall.function.arguments);
            } catch (parseError) {
              console.error(
                `[Client] Bad args for ${functionName}: ${toolCall.function.arguments}`,
                parseError
              );
              toolResponses.push({
                tool_call_id: toolCall.id,
                role: "tool",
                content: `Error: Invalid AI args for ${functionName}.`,
              });
              continue;
            }
            let toolResultContent = "Error: Tool execution failed.";
            let mcpToolResult: CallToolResult | null = null;
            try {
              console.log(
                `[Client] Executing MCP: ${functionName}`,
                functionArgs
              );
              if (functionName === "add_system_note") {
                mcpToolResult = (await mcpClient.callTool({
                  name: "add_system_note",
                  arguments: {
                    sessionId,
                    note: (functionArgs as any)?.note ?? "",
                  },
                })) as CallToolResult | null;
              } else if (functionName === "list_sessions") {
                mcpToolResult = (await mcpClient.callTool({
                  name: "list_sessions",
                  arguments: {},
                })) as CallToolResult | null;
              } else if (functionName === "end_session") {
                console.log("[Client] AI requested end session.");
                mcpToolResult = (await mcpClient.callTool({
                  name: "end_session",
                  arguments: { sessionId },
                })) as CallToolResult | null;
                toolResultContent =
                  extractTextFromResult(mcpToolResult) ??
                  "Session end acknowledged.";
                shouldExit = true;
              } else {
                console.error(`[Client] Unknown tool: ${functionName}`);
                toolResultContent = `Error: Unknown tool '${functionName}'.`;
                toolResponses.push({
                  tool_call_id: toolCall.id,
                  role: "tool",
                  content: toolResultContent,
                });
                continue;
              }
              if (mcpToolResult) {
                const txt = extractTextFromResult(mcpToolResult);
                toolResultContent =
                  txt !== null && txt.trim() !== ""
                    ? txt
                    : `Tool ${functionName} OK.`;
                console.log(
                  `[Client] MCP result ${functionName}: ${toolResultContent.substring(
                    0,
                    100
                  )}...`
                );
              }
            } catch (toolError) {
              console.error(
                `[Client] MCP tool error ${functionName}:`,
                toolError
              );
              toolResultContent = `Error executing ${functionName}: ${
                toolError instanceof Error ? toolError.message : "Unknown"
              }`;
            }
            if (!shouldExit) {
              toolResponses.push({
                tool_call_id: toolCall.id,
                role: "tool",
                content: toolResultContent,
              });
            }
            if (shouldExit) break;
          } // End tool loop

          if (shouldExit) {
            console.log(
              "Assistant:",
              finalAssistantContent ?? "Okay, ending session."
            );
            break;
          } // Exit main loop

          // Add tool responses to local history for next OpenAI call
          toolResponses.forEach((toolMsg) => messagesForOpenAI.push(toolMsg));

          // Second OpenAI call
          console.log("[Client] Sending tool results to OpenAI...");
          response = await openai.chat.completions.create({
            model: "gpt-4o-mini-2024-07-18",
            messages: messagesForOpenAI,
          });
          message = response.choices[0].message;
          finalAssistantContent = message.content; // Update final content
        } // End tool call handling

        // Process and display final response
        const assistantResponseText =
          finalAssistantContent ?? "Sorry, couldn't generate response.";
        console.log(`Assistant: ${assistantResponseText}`);

        // Add final assistant message to server transcript
        const addAssistantResult = (await mcpClient.callTool({
          name: "add_message",
          arguments: {
            sessionId,
            role: "assistant",
            content: assistantResponseText,
          },
        })) as CallToolResult | null;
        if (extractTextFromResult(addAssistantResult) === null) {
          console.error("[Client] Failed store final assistant msg.");
        }
      } catch (error) {
        /* ... error handling ... */ console.error(
          "[Client] OpenAI/Tool error:",
          error instanceof Error ? error.message : error
        );
        console.log(`Assistant: Error processing request.`);
      }
    } // End while loop
  } catch (error) {
    /* ... error handling ... */ console.error(
      "[Client] Critical error:",
      error instanceof Error ? error.message : error
    );
  } finally {
    /* ... cleanup (unchanged) ... */ console.log("[Client] Cleaning up...");
    rl.close();
    if (isConnected) {
      try {
        await mcpClient.close();
        console.log("[Client] MCP connection closed.");
      } catch (closeError) {
        console.error("[Client] MCP close error:", closeError);
      }
    } else {
      console.log("[Client] MCP not connected.");
    }
  }
}

main().catch((error) => {
  /* ... error handling ... */ console.error(
    "[Client] Unhandled main error:",
    error
  );
  process.exit(1);
});
