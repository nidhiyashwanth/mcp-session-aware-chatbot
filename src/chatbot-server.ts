// src/chatbot-server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TextContent } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { type StoredChatMessage, type ChatMessage } from "./types.js"; // Correct import

// --- File-Based Session Storage & Helpers (Unchanged) ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');

async function ensureSessionsDirExists() { /* ... unchanged ... */
     try {
        await fs.access(SESSIONS_DIR);
        console.error(`[Server] Sessions directory found: ${SESSIONS_DIR}`);
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            console.error(`[Server] Sessions directory not found. Creating: ${SESSIONS_DIR}`);
            await fs.mkdir(SESSIONS_DIR, { recursive: true });
        } else {
            console.error("[Server] Error checking sessions directory:", error);
            throw error;
        }
    }
 }
const getSessionFilePath = (sessionId: string): string => { /* ... unchanged ... */
    if (!/^[a-f0-9-]+$/.test(sessionId)) {
        throw new Error("Invalid session ID format.");
    }
    return path.join(SESSIONS_DIR, `${sessionId}.json`);
 };
async function readTranscript(sessionId: string): Promise<StoredChatMessage[] | null> { /* ... unchanged ... */
     const filePath = getSessionFilePath(sessionId);
    try {
        const fileContent = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(fileContent);
        if (Array.isArray(parsed)) {
             return parsed as StoredChatMessage[];
        }
        console.error(`[Server] Parsed session data is not an array: ${filePath}`);
        return null;
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            return null;
        }
        console.error(`[Server] Error reading session file ${filePath}:`, error);
        throw error;
    }
 }
async function writeTranscript(sessionId: string, transcript: StoredChatMessage[]): Promise<void> { /* ... unchanged ... */
     const filePath = getSessionFilePath(sessionId);
    try {
        const fileContent = JSON.stringify(transcript, null, 2);
        await fs.writeFile(filePath, fileContent, 'utf-8');
    } catch (error) {
        console.error(`[Server] Error writing session file ${filePath}:`, error);
        throw error;
    }
 }
// -------------------------------------------------------

const server = new McpServer({
    name: "chatbot-session-manager-file-ai",
    version: "1.3.0", // Incremented version
    capabilities: {
        tools: {},
    },
});

// --- Tool Definitions ---

// Start session - unchanged
server.tool("start_session", /* ... unchanged ... */
    "Starts a new chat session, creates its persistent file, and returns its unique ID.",
    {},
    async () => {
        const sessionId = uuidv4();
        try {
            await writeTranscript(sessionId, []);
            console.error(`[Server] Session started and file created: ${sessionId}`);
            return { content: [{ type: "text", text: sessionId }] };
        } catch (error) { /* ... error handling ... */
            console.error(`[Server] Failed to create session file for ${sessionId}:`, error);
            return { isError: true, content: [{ type: "text", text: "Error: Failed to initialize session storage." }] };
         }
    }
);

// Add user/assistant message - unchanged
server.tool("add_message", /* ... unchanged ... */
    "Adds a USER or ASSISTANT message to the specified chat session transcript file.",
    { sessionId: z.string().uuid(), role: z.enum(["user", "assistant"]), content: z.string().min(1) },
    async ({ sessionId, role, content }) => {
        try {
            const transcript = await readTranscript(sessionId);
            if (transcript === null) { /* ... error handling ... */
                console.error(`[Server] Error: Session file not found for ID: ${sessionId}`);
                return { isError: true, content: [{ type: "text", text: `Error: Session with ID ${sessionId} not found.` }] };
             }
            const newMessage: StoredChatMessage = { role, content };
            transcript.push(newMessage);
            await writeTranscript(sessionId, transcript);
            console.error(`[Server] Message added to session ${sessionId}: [${role}] ${content.substring(0, 50)}...`);
            return { content: [{ type: "text", text: "Message added successfully." }] };
        } catch (error) { /* ... error handling ... */
            console.error(`[Server] Error processing add_message for session ${sessionId}:`, error);
            return { isError: true, content: [{ type: "text", text: "Error: Failed to add message to session storage." }] };
         }
    }
);

// Add system note - unchanged
server.tool("add_system_note", /* ... unchanged ... */
    "Adds a SYSTEM message (a note or instruction) to the specified chat session transcript file. Use this to add context or guidance.",
    { sessionId: z.string().uuid(), note: z.string().min(1) },
    async ({ sessionId, note }) => {
         try {
            const transcript = await readTranscript(sessionId);
            if (transcript === null) { /* ... error handling ... */
                console.error(`[Server] Error: Session file not found for ID: ${sessionId}`);
                return { isError: true, content: [{ type: "text", text: `Error: Session with ID ${sessionId} not found.` }] };
             }
            const newMessage: StoredChatMessage = { role: "system", content: note };
            transcript.push(newMessage);
            await writeTranscript(sessionId, transcript);
            console.error(`[Server] System note added to session ${sessionId}: ${note.substring(0, 50)}...`);
            return { content: [{ type: "text", text: "System note added successfully." }] };
        } catch (error) { /* ... error handling ... */
             console.error(`[Server] Error processing add_system_note for session ${sessionId}:`, error);
            return { isError: true, content: [{ type: "text", text: "Error: Failed to add system note." }] };
         }
    }
);

// Get transcript - unchanged
server.tool("get_transcript", /* ... unchanged ... */
    "Retrieves the full message transcript JSON string from the specified chat session file.",
    { sessionId: z.string().uuid() },
    async ({ sessionId }) => { /* ... unchanged ... */
        const filePath = getSessionFilePath(sessionId);
        try {
            const transcriptJson = await fs.readFile(filePath, 'utf-8');
             if (!transcriptJson.trim().startsWith('[') || !transcriptJson.trim().endsWith(']')) {
                 console.error(`[Server] Warning: Content read from ${filePath} does not look like a JSON array.`);
            }
            console.error(`[Server] Transcript retrieved for session ${sessionId}, length: ${transcriptJson.length} chars`);
            return { content: [{ type: "text", text: transcriptJson }] };
        } catch (error: any) {
            if (error.code === 'ENOENT') { /* ... error handling ... */
                console.error(`[Server] Error: Session file not found for ID: ${sessionId}`);
                return { isError: true, content: [{ type: "text", text: `Error: Session with ID ${sessionId} not found.` }] };
             }
            console.error(`[Server] Error reading transcript for session ${sessionId}:`, error);
            return { isError: true, content: [{ type: "text", text: "Error: Failed to read session transcript." }] };
        }
    }
);

// List sessions - unchanged
server.tool("list_sessions", /* ... unchanged ... */
    "Lists the IDs of all currently stored chat sessions.",
    {},
    async () => { /* ... unchanged ... */
        try {
            await ensureSessionsDirExists();
            const files = await fs.readdir(SESSIONS_DIR);
            const sessionIds = files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
            console.error(`[Server] Listed sessions: ${sessionIds.join(', ')}`);
            return { content: [{ type: "text", text: JSON.stringify(sessionIds) }] };
        } catch (error) { /* ... error handling ... */
            console.error(`[Server] Error listing sessions in ${SESSIONS_DIR}:`, error);
            return { isError: true, content: [{ type: "text", text: "Error: Failed to list sessions." }] };
        }
    }
);

// *** NEW TOOL: End Session (Logs only for stdio) ***
server.tool(
    "end_session",
    "Signals that the user wants to end the current chat session. The client will handle disconnection.",
    {
        sessionId: z.string().uuid().describe("The unique ID of the session to end."),
        // Optional reason? Might be useful later.
        // reason: z.string().optional().describe("Optional reason for ending the session.")
    },
    async ({ sessionId /*, reason */ }) => {
        // For stdio transport, the primary action is the client disconnecting.
        // We just log this event on the server side.
        // If using a different transport (like SSE), more complex cleanup might happen here.
        console.error(`[Server] Received request to end session: ${sessionId}. Client should now disconnect.`);
        // We don't delete the file here, session history is preserved.
        return {
            content: [{ type: "text", text: `Session ${sessionId} marked for termination by client.` }]
        };
        // NOTE: This tool doesn't actually *stop* the server process itself for stdio.
    }
);


// --- Main Server Execution ---
async function main() { /* ... unchanged ... */
    await ensureSessionsDirExists();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[Server] AI Chatbot Session File MCP Server running on stdio... Storing sessions in ${SESSIONS_DIR}`);
 }

main().catch((error) => { /* ... unchanged ... */
    console.error("[Server] Fatal error:", error);
    process.exit(1);
 });