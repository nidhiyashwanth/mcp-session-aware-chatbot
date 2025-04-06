// src/chatbot-server.ts
// (Keep the exact code from the previous version that was working correctly)
// It should define tools: start_session, add_message, add_system_note,
// get_transcript, list_sessions, end_session
// and use the file system helpers (ensureSessionsDirExists, etc.)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TextContent } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { type StoredChatMessage } from "./types.js"; // Use StoredChatMessage

// --- File-Based Session Storage & Helpers ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');

async function ensureSessionsDirExists() {
     try {
        await fs.access(SESSIONS_DIR);
        console.error(`[MCP Server] Sessions directory found: ${SESSIONS_DIR}`);
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            console.error(`[MCP Server] Sessions directory not found. Creating: ${SESSIONS_DIR}`);
            await fs.mkdir(SESSIONS_DIR, { recursive: true });
        } else {
            console.error("[MCP Server] Error checking sessions directory:", error);
            throw error;
        }
    }
 }
const getSessionFilePath = (sessionId: string): string => {
    if (!/^[a-f0-9-]+$/.test(sessionId)) {
        throw new Error("Invalid session ID format.");
    }
    return path.join(SESSIONS_DIR, `${sessionId}.json`);
 };

async function readTranscript(sessionId: string): Promise<StoredChatMessage[] | null> {
     const filePath = getSessionFilePath(sessionId);
    try {
        const fileContent = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(fileContent);
        if (Array.isArray(parsed)) {
             return parsed as StoredChatMessage[];
        }
        console.error(`[MCP Server] Parsed session data is not an array: ${filePath}`);
        return null;
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            return null;
        }
        console.error(`[MCP Server] Error reading session file ${filePath}:`, error);
        throw error;
    }
 }

async function writeTranscript(sessionId: string, transcript: StoredChatMessage[]): Promise<void> {
     const filePath = getSessionFilePath(sessionId);
    try {
        const fileContent = JSON.stringify(transcript, null, 2);
        await fs.writeFile(filePath, fileContent, 'utf-8');
    } catch (error) {
        console.error(`[MCP Server] Error writing session file ${filePath}:`, error);
        throw error;
    }
 }
// -------------------------------------------------------

const server = new McpServer({
    name: "chatbot-session-manager-file-ai",
    version: "1.3.0", // Keep version consistent or update
    capabilities: {
        tools: {},
    },
});

// --- Tool Definitions (Keep all tools from previous version) ---

server.tool("start_session", /* ... */
    "Starts a new chat session, creates its persistent file, and returns its unique ID.",
    {},
    async () => {
        const sessionId = uuidv4();
        try {
            await writeTranscript(sessionId, []);
            console.error(`[MCP Server] Session started and file created: ${sessionId}`);
            return { content: [{ type: "text", text: sessionId }] };
        } catch (error) {
            console.error(`[MCP Server] Failed to create session file for ${sessionId}:`, error);
            return { isError: true, content: [{ type: "text", text: "Error: Failed to initialize session storage." }] };
         }
    }
);

server.tool("add_message", /* ... */
    "Adds a USER or ASSISTANT message to the specified chat session transcript file.",
    { sessionId: z.string().uuid(), role: z.enum(["user", "assistant"]), content: z.string().min(1) },
    async ({ sessionId, role, content }) => {
        try {
            const transcript = await readTranscript(sessionId);
            if (transcript === null) {
                console.error(`[MCP Server] Error: Session file not found for ID: ${sessionId}`);
                return { isError: true, content: [{ type: "text", text: `Error: Session with ID ${sessionId} not found.` }] };
             }
            const newMessage: StoredChatMessage = { role, content };
            transcript.push(newMessage);
            await writeTranscript(sessionId, transcript);
            console.error(`[MCP Server] Message added to session ${sessionId}: [${role}] ${content.substring(0, 50)}...`);
            return { content: [{ type: "text", text: "Message added successfully." }] };
        } catch (error) {
            console.error(`[MCP Server] Error processing add_message for session ${sessionId}:`, error);
            return { isError: true, content: [{ type: "text", text: "Error: Failed to add message to session storage." }] };
         }
    }
);

server.tool("add_system_note", /* ... */
    "Adds a SYSTEM message (a note or instruction) to the specified chat session transcript file. Use this to add context or guidance.",
    { sessionId: z.string().uuid(), note: z.string().min(1) },
    async ({ sessionId, note }) => {
         try {
            const transcript = await readTranscript(sessionId);
            if (transcript === null) {
                console.error(`[MCP Server] Error: Session file not found for ID: ${sessionId}`);
                return { isError: true, content: [{ type: "text", text: `Error: Session with ID ${sessionId} not found.` }] };
             }
            const newMessage: StoredChatMessage = { role: "system", content: note };
            transcript.push(newMessage);
            await writeTranscript(sessionId, transcript);
            console.error(`[MCP Server] System note added to session ${sessionId}: ${note.substring(0, 50)}...`);
            return { content: [{ type: "text", text: "System note added successfully." }] };
        } catch (error) {
             console.error(`[MCP Server] Error processing add_system_note for session ${sessionId}:`, error);
            return { isError: true, content: [{ type: "text", text: "Error: Failed to add system note." }] };
         }
    }
);

server.tool("get_transcript", /* ... */
    "Retrieves the full message transcript JSON string from the specified chat session file.",
    { sessionId: z.string().uuid() },
    async ({ sessionId }) => {
        const filePath = getSessionFilePath(sessionId);
        try {
            const transcriptJson = await fs.readFile(filePath, 'utf-8');
             if (!transcriptJson.trim().startsWith('[') || !transcriptJson.trim().endsWith(']')) {
                 console.error(`[MCP Server] Warning: Content read from ${filePath} does not look like a JSON array.`);
            }
            console.error(`[MCP Server] Transcript retrieved for session ${sessionId}, length: ${transcriptJson.length} chars`);
            return { content: [{ type: "text", text: transcriptJson }] };
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                console.error(`[MCP Server] Error: Session file not found for ID: ${sessionId}`);
                return { isError: true, content: [{ type: "text", text: `Error: Session with ID ${sessionId} not found.` }] };
             }
            console.error(`[MCP Server] Error reading transcript for session ${sessionId}:`, error);
            return { isError: true, content: [{ type: "text", text: "Error: Failed to read session transcript." }] };
        }
    }
);

server.tool("list_sessions", /* ... */
    "Lists the IDs of all currently stored chat sessions.",
    {},
    async () => {
        try {
            await ensureSessionsDirExists();
            const files = await fs.readdir(SESSIONS_DIR);
            const sessionIds = files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
            console.error(`[MCP Server] Listed sessions: ${sessionIds.join(', ')}`);
            return { content: [{ type: "text", text: JSON.stringify(sessionIds) }] };
        } catch (error) {
            console.error(`[MCP Server] Error listing sessions in ${SESSIONS_DIR}:`, error);
            return { isError: true, content: [{ type: "text", text: "Error: Failed to list sessions." }] };
        }
    }
);

server.tool("end_session", /* ... */
    "Signals that the user wants to end the current chat session. The client will handle disconnection.",
    { sessionId: z.string().uuid().describe("The unique ID of the session to end.") },
    async ({ sessionId }) => {
        console.error(`[MCP Server] Received request to end session: ${sessionId}. Client should now disconnect.`);
        return { content: [{ type: "text", text: `Session ${sessionId} marked for termination by client.` }] };
    }
);

// --- Main Server Execution ---
async function main() {
    await ensureSessionsDirExists();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[MCP Server] AI Chatbot Session File MCP Server running on stdio... Storing sessions in ${SESSIONS_DIR}`);
 }

main().catch((error) => {
    console.error("[MCP Server] Fatal error:", error);
    process.exit(1);
 });