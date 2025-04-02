// src/chatbot-client.ts
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResult, TextContent } from "@modelcontextprotocol/sdk/types.js";
import OpenAI from "openai";
import {
    ChatCompletionTool,
    ChatCompletionMessageParam,
    ChatCompletionToolMessageParam
} from "openai/resources/chat/completions";
import * as dotenv from "dotenv";
import readline from "readline/promises";
import { ChatMessage, StoredChatMessage } from "./types.js"; // Ensure both are imported

dotenv.config();

// --- OpenAI Setup (Unchanged) ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
if (!process.env.OPENAI_API_KEY) { /* ... error handling ... */
    console.error("[Client] Error: OPENAI_API_KEY not found in .env file.");
    process.exit(1);
 }

// --- Define Tools for OpenAI (ADD end_session) ---
const availableTools: ChatCompletionTool[] = [
    {
        type: "function",
        function: {
            name: "add_system_note",
            description: "Adds a SYSTEM message (a note or instruction) to the current chat session transcript. Use this to add context, summarize points, or provide guidance for future interactions.",
            parameters: { /* ... unchanged ... */
                type: "object",
                properties: {
                    note: { type: "string", description: "The content of the system note to add." },
                },
                required: ["note"],
             },
        },
    },
    {
        type: "function",
        function: {
            name: "list_sessions",
            description: "Lists the IDs of all previously stored chat sessions.",
            parameters: { type: "object", properties: {} },
        },
    },
    // *** NEW TOOL DEFINITION FOR AI ***
    {
        type: "function",
        function: {
            name: "end_session",
            description: "Ends the current chat session and disconnects the client. Use when the user explicitly asks to quit, stop, exit, or indicates they are finished.",
            parameters: { type: "object", properties: {} } // No parameters needed from AI
        }
    }
];
// -----------------------------------------------------

// --- MCP Client Setup (Unchanged) ---
const transport = new StdioClientTransport({
  command: "node",
  args: ["build/chatbot-server.js"],
});
const mcpClient = new McpClient({ name: "chatbot-cli-client-ai", version: "1.3.0" }, {});
// ------------------------------------

// --- Helper Functions (Unchanged) ---
function extractTextFromResult(result: CallToolResult | null): string | null { /* ... unchanged ... */
  if (!result) { console.error("[Client] Received null result from server call."); return null; }
  if (result.isError) { const errorText = (result.content?.[0] as TextContent)?.text || "Unknown server error"; console.error(`[Client] Tool call failed on server: ${errorText}`); return null; }
  if (!result.content || result.content.length === 0 || result.content[0]?.type !== 'text') { console.error("[Client] Received unexpected result format from server:", JSON.stringify(result)); return null; }
  return (result.content[0] as TextContent).text;
}
function parseTranscript(jsonString: string | null): StoredChatMessage[] | null { /* ... unchanged ... */
    if (!jsonString) { console.error("[Client] Cannot parse null transcript string."); return null; }
    try {
        const transcript = JSON.parse(jsonString);
        if (Array.isArray(transcript) && transcript.every(msg => msg && typeof msg.role === 'string' && (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'system') && typeof msg.content === 'string')) {
            return transcript as StoredChatMessage[];
        }
        console.error("[Client] Parsed transcript data is not a valid StoredChatMessage array:", transcript);
        return null;
    } catch (e) { console.error("[Client] Failed to parse transcript JSON:", e, "\nReceived JSON string:", jsonString); return null; }
}
// ------------------------------------

// --- Main Application Logic ---
async function main() {
  let sessionId: string | null = null;
  let isConnected = false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log("[Client] Connecting to Chatbot Session MCP Server...");
    await mcpClient.connect(transport);
    isConnected = true;
    console.log("[Client] Connected successfully.");

    console.log("[Client] Starting new session...");
    const startResult = await mcpClient.callTool({ name: "start_session", arguments: {} }) as CallToolResult | null;
    sessionId = extractTextFromResult(startResult);

    if (!sessionId) { throw new Error("Failed to start a new session."); }
    console.log(`[Client] Session started with ID: ${sessionId}`);
    console.log("\nChatbot Ready. Ask the assistant to quit when you're done."); // Updated hint

    // Main chat loop
    while (true) {
      const userInput = await rl.question("You: ");

      // --- REMOVED CLIENT-SIDE /quit CHECK ---

      let storeUserMessage = true; // Flag to control storing user input

      // 1. Get transcript *before* deciding whether to store user message
      const transcriptResult = await mcpClient.callTool({
          name: "get_transcript",
          arguments: { sessionId }
      }) as CallToolResult | null;
      const transcriptJson = extractTextFromResult(transcriptResult);
      // Parse into StoredChatMessage[], then cast to ChatMessage[] for OpenAI
      // Initialize with existing transcript OR empty array if failed/first turn
      const messagesForOpenAI: ChatMessage[] = (parseTranscript(transcriptJson) ?? []) as ChatMessage[];

      // Add the *current* user input to the list we send to OpenAI this turn
      messagesForOpenAI.push({ role: "user", content: userInput });

      // 2. Call OpenAI, potentially handling tool calls
      console.log("[Client] Getting response from OpenAI...");
      try {
        let response = await openai.chat.completions.create({
            model: "gpt-4o-mini-2024-07-18",
            messages: messagesForOpenAI, // Send potentially updated history
            tools: availableTools,
            tool_choice: "auto",
        });

        let message = response.choices[0].message;
        const toolCalls = message.tool_calls;
        let finalAssistantContent: string | null = message.content; // May be null if only tool calls
        let shouldExit = false; // Flag to break loop after processing

        // --- Check if user message should be skipped ---
        if (toolCalls && toolCalls.length > 0 && !finalAssistantContent) {
            // If AI *only* responded with tool calls and no text, assume user input was a command
            console.log("[Client] User input interpreted as command, not storing as user message.");
            storeUserMessage = false;
        }
        // -------------------------------------------------

        // --- ADD USER MESSAGE (Conditional) ---
        if (storeUserMessage) {
            console.log("[Client] Storing user message...")
            const addUserResult = await mcpClient.callTool({
                name: "add_message",
                arguments: { sessionId, role: "user", content: userInput }
            }) as CallToolResult | null;
            if (extractTextFromResult(addUserResult) === null) {
                console.error("[Client] Failed to add user message. Skipping AI call this turn.");
                continue; // Or handle more gracefully
            }
        }
        // ---------------------------------------


        // --- Tool Calling Loop ---
        if (toolCalls && toolCalls.length > 0) {
            console.log("[Client] AI requested tool calls:", toolCalls.map(tc => tc.function.name).join(', '));

            // Add assistant's tool call request to the *local* list for OpenAI's context
            messagesForOpenAI.push(message);

            const toolResponses: ChatCompletionToolMessageParam[] = [];

            for (const toolCall of toolCalls) {
                const functionName = toolCall.function.name;
                // Safely parse arguments, default to empty object if needed
                let functionArgs = {};
                try {
                    if (toolCall.function.arguments) {
                        functionArgs = JSON.parse(toolCall.function.arguments);
                    }
                } catch (parseError) {
                    console.error(`[Client] Failed to parse arguments for ${functionName}: ${toolCall.function.arguments}`, parseError);
                    // Decide how to handle - skip tool, send error result? Sending error result:
                     toolResponses.push({
                        tool_call_id: toolCall.id,
                        role: "tool",
                        content: `Error: Invalid arguments provided by AI for ${functionName}.`,
                    });
                    continue; // Skip this tool call
                }

                let toolResultContent = "Error: Tool execution failed."; // Default error
                let mcpToolResult: CallToolResult | null = null;

                try {
                    console.log(`[Client] Executing MCP tool: ${functionName} with args:`, functionArgs);

                    if (functionName === "add_system_note") {
                        mcpToolResult = await mcpClient.callTool({
                            name: "add_system_note",
                            // Add sessionId and ensure 'note' exists
                            arguments: { sessionId, note: (functionArgs as any)?.note ?? '' }
                        }) as CallToolResult | null;
                    } else if (functionName === "list_sessions") {
                         mcpToolResult = await mcpClient.callTool({
                            name: "list_sessions",
                            arguments: {}
                        }) as CallToolResult | null;
                    // *** HANDLE end_session TOOL CALL ***
                    } else if (functionName === "end_session") {
                         console.log("[Client] AI requested to end session.");
                         // Optionally call the server tool
                         mcpToolResult = await mcpClient.callTool({
                            name: "end_session",
                            arguments: { sessionId }
                         }) as CallToolResult | null;
                         toolResultContent = extractTextFromResult(mcpToolResult) ?? "Session termination acknowledged.";
                         shouldExit = true; // Set flag to exit after processing
                    } else {
                        console.error(`[Client] AI requested unknown tool: ${functionName}`);
                        toolResultContent = `Error: Unknown tool '${functionName}' requested.`;
                         // No MCP call, directly add error response for OpenAI
                        toolResponses.push({
                            tool_call_id: toolCall.id,
                            role: "tool",
                            content: toolResultContent,
                        });
                        continue; // Skip to next tool call if any
                    }

                    // Process MCP result (if a call was made)
                    if (mcpToolResult) {
                         const extractedText = extractTextFromResult(mcpToolResult);
                         // Use extracted text, or provide a generic success message if null/empty
                         toolResultContent = extractedText !== null && extractedText.trim() !== ''
                                              ? extractedText
                                              : `Tool ${functionName} executed successfully.`;
                         console.log(`[Client] MCP tool ${functionName} result: ${toolResultContent.substring(0, 100)}...`);
                    }

                } catch (toolError) {
                    console.error(`[Client] Error executing MCP tool ${functionName}:`, toolError);
                    toolResultContent = `Error executing tool ${functionName}: ${toolError instanceof Error ? toolError.message : 'Unknown error'}`;
                }

                // Add tool result message for OpenAI context (unless exiting immediately)
                 if (!shouldExit) { // Don't need tool result if we are exiting anyway
                    toolResponses.push({
                        tool_call_id: toolCall.id,
                        role: "tool",
                        content: toolResultContent,
                    });
                 }

                 // If end_session was called, break the tool loop early
                 if (shouldExit) break;

            } // End of tool call loop

            // If exiting, break the main loop now
            if (shouldExit) {
                console.log("Assistant:", finalAssistantContent ?? "Okay, ending session."); // Give a final word
                break; // Exit the main 'while (true)' loop
            }

            // Add all tool responses to the *local* transcript for the next OpenAI call
            toolResponses.forEach(toolMsg => messagesForOpenAI.push(toolMsg));

            // 4. Make the second call to OpenAI with tool results
            console.log("[Client] Sending tool results back to OpenAI...");
            response = await openai.chat.completions.create({
                model: "gpt-4o-mini-2024-07-18",
                messages: messagesForOpenAI, // Send history including tool calls and results
            });
            message = response.choices[0].message;
            finalAssistantContent = message.content; // Update final content

        } // End of tool call handling

        // 5. Process and display the final response from OpenAI
        const assistantResponseText = finalAssistantContent ?? "Sorry, I couldn't generate a response this time.";
        console.log(`Assistant: ${assistantResponseText}`);

        // 6. Add the *final* assistant message to the *server* transcript
        const addAssistantResult = await mcpClient.callTool({
            name: "add_message",
            arguments: { sessionId, role: "assistant", content: assistantResponseText }
        }) as CallToolResult | null;
        if (extractTextFromResult(addAssistantResult) === null) {
            console.error("[Client] Failed to add final assistant message. Server history may be incomplete.");
        }

      } catch (error) { /* ... error handling ... */
          console.error("[Client] Error during OpenAI call or tool execution:", error instanceof Error ? error.message : error);
          console.log(`Assistant: Sorry, an error occurred while processing your request.`);
       }
    } // End while loop

  } catch (error) { /* ... error handling ... */
    console.error("[Client] A critical error occurred:", error instanceof Error ? error.message : error);
   } finally {
    console.log("[Client] Cleaning up...");
    rl.close();
    if (isConnected) { /* ... cleanup ... */
        try {
            // Ensure close is called if connected, regardless of how loop exited
            await mcpClient.close();
            console.log("[Client] MCP connection closed.");
        } catch (closeError) {
            console.error("[Client] Error closing MCP connection:", closeError);
        }
     } else {
        console.log("[Client] MCP client was not connected or already closed.");
    }
  }
}

main().catch((error) => { /* ... error handling ... */
    console.error("[Client] Unhandled error in main execution:", error);
    process.exit(1);
 });