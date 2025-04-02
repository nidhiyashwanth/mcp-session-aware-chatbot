# MCP Chatbot Session Manager

This project demonstrates a persistent chatbot session management system built using the Model Context Protocol (MCP). It consists of:

1.  **MCP Server (`chatbot-server.ts`):** Manages chat session transcripts using the local filesystem for persistence (for demonstration purposes).
2.  **AI-Powered MCP Client (`chatbot-client.ts`):** Interacts with the user, communicates with the MCP server to manage session state, and uses the OpenAI API (GPT-4o Mini) to generate responses and decide when to use server tools.

## Features

*   **Persistent Chat Sessions:** Stores conversation history across multiple interactions.
*   **MCP Integration:** Uses MCP for standardized communication between the client and session management logic.
*   **Filesystem Storage:** Uses local JSON files (`./sessions/*.json`) to store transcripts (suitable for demo, **not production**).
*   **AI-Driven Client:** Leverages OpenAI's function/tool calling capabilities to interact with the MCP server tools.
*   **Tool-Based Session Management:** Provides specific MCP tools for starting sessions, adding messages (user, assistant, system), retrieving transcripts, listing sessions, and ending sessions.
*   **System Message Injection:** Allows the AI (or potentially the user via commands) to add system-level notes or instructions into the conversation history via the `add_system_note` tool.
*   **Graceful Session Termination:** Handles session ending via the `end_session` tool requested by the AI.

## How it Works

1.  **Initialization:** The `chatbot-client.js` is executed. It uses the `StdioClientTransport` to start the `chatbot-server.js` process and establish an MCP connection over standard input/output.
2.  **Session Start:** The client automatically calls the `start_session` MCP tool on the server. The server creates a new unique session ID, creates a corresponding empty JSON file in the `sessions/` directory, and returns the session ID to the client.
3.  **User Interaction:** The client prompts the user for input in a loop.
4.  **Transcript Retrieval:** Before calling the AI, the client calls the `get_transcript` MCP tool to fetch the current session history from the server's JSON file.
5.  **AI Processing:** The client sends the retrieved transcript (formatted as messages) along with the latest user input to the OpenAI API. It also provides the definitions of available MCP tools (`add_system_note`, `list_sessions`, `end_session`).
6.  **AI Response/Tool Call:**
    *   If OpenAI returns a text response, the client displays it.
    *   If OpenAI requests one or more tool calls:
        *   The client parses the request.
        *   It executes the corresponding MCP tool(s) on the server (e.g., `add_system_note`, `list_sessions`, or `end_session`).
        *   It sends the results from the MCP tools back to OpenAI.
        *   OpenAI uses the tool results to generate a final text response, which the client then displays.
7.  **Transcript Update:**
    *   The client determines if the user's input should be stored (e.g., it doesn't store input if the AI *only* responded with tool calls, interpreting the input as a command).
    *   If the input is stored, the client calls the `add_message` MCP tool with `role: "user"` and the user's input.
    *   The client calls the `add_message` MCP tool with `role: "assistant"` and the final text response from OpenAI. The server appends these messages to the session's JSON file.
8.  **Ending Session:** If the AI calls the `end_session` tool (usually based on user request like "quit" or "exit"), the client:
    *   Calls the corresponding `end_session` MCP tool on the server (which primarily logs the event for stdio).
    *   Prints a final message.
    *   Breaks the chat loop.
    *   Initiates the cleanup process, closing the MCP connection which terminates the server process.
9.  **Cleanup:** When the loop terminates (normally or via error), the client closes the MCP connection and exits.

## Server Tools Explained

The MCP server (`chatbot-server.ts`) exposes the following tools:

*   `start_session`:
    *   **Description:** Starts a new chat session.
    *   **Action:** Generates a UUID, creates an empty `sessions/<uuid>.json` file.
    *   **Returns:** The new session ID (string).
*   `add_message`:
    *   **Description:** Adds a `user` or `assistant` message to the session transcript.
    *   **Action:** Reads the session file, appends the new message object, writes the file back.
    *   **Returns:** Confirmation message (string).
*   `add_system_note`:
    *   **Description:** Adds a `system` message (note/instruction) to the transcript.
    *   **Action:** Reads the session file, appends the system message object, writes the file back.
    *   **Returns:** Confirmation message (string).
*   `get_transcript`:
    *   **Description:** Retrieves the full message transcript for a session.
    *   **Action:** Reads the content of the `sessions/<sessionId>.json` file.
    *   **Returns:** The transcript as a JSON string.
*   `list_sessions`:
    *   **Description:** Lists the IDs of all stored chat sessions.
    *   **Action:** Reads the filenames in the `sessions/` directory.
    *   **Returns:** A JSON string array of session IDs.
*   `end_session`:
    *   **Description:** Signals the client should end the session.
    *   **Action (for stdio):** Logs the request on the server. The client handles the actual disconnection.
    *   **Returns:** Confirmation message (string).

## Client Functionality

The MCP client (`chatbot-client.ts`) handles:

*   Connecting to and managing the lifecycle of the MCP server process.
*   Interacting with the user via the command line (using `readline`).
*   Calling the OpenAI API with the conversation history and tool definitions.
*   Parsing OpenAI's responses, including handling tool call requests.
*   Invoking the appropriate MCP server tools based on AI requests.
*   Maintaining the conversation context by fetching the transcript before each AI call.
*   Conditionally storing user messages to avoid logging simple commands.
*   Storing the final assistant messages.
*   Gracefully shutting down the connection when the `end_session` tool is triggered by the AI.

## Persistence Layer (Filesystem - Demo Only)

This implementation uses the local filesystem (`./sessions/` directory relative to the *built* server file `build/chatbot-server.js`) to store chat transcripts as individual JSON files named `<sessionId>.json`.

**Disclaimer:** This approach is **highly unsuitable for production environments**.
*   **Concurrency:** It does not handle concurrent access safely. Multiple clients or processes interacting with the same files could lead to data corruption.
*   **Scalability:** Filesystem I/O can become a bottleneck with many sessions or long transcripts.
*   **Reliability:** Simple file operations lack the robustness, transactionality, and backup features of a proper database.

For any real-world application, replace the file I/O functions (`readTranscript`, `writeTranscript`, `list_sessions`) with interactions with a database like PostgreSQL, MongoDB, SQLite, etc.

## Setup and Running

### Prerequisites

*   Node.js (v16 or higher recommended for ES Modules support)
*   npm (or yarn)
*   An OpenAI API Key

### Steps

1.  **Clone the repository:**
    ```bash
    git clone <repository-url>
    cd <repository-directory>
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    # or
    # yarn install
    ```

3.  **Set up Environment Variables:**
    Create a `.env` file in the project root:
    ```plaintext
    # .env
    OPENAI_API_KEY=sk-YourSecretOpenAiApiKeyHere
    ```
    Replace `sk-YourSecretOpenAiApiKeyHere` with your actual OpenAI API key.

    **IMPORTANT:** Add `.env` to your `.gitignore` file to avoid committing your API key.
    ```bash
    echo ".env" >> .gitignore
    ```

4.  **Build the TypeScript code:**
    ```bash
    npm run build
    ```
    (This assumes you have a `build` script in your `package.json` like `"build": "tsc"`)

5.  **Run the client:**
    ```bash
    node build/chatbot-client.js
    ```
    This command starts the client. The client will then automatically start the server process (`node build/chatbot-server.js`) and connect to it via standard input/output.

6.  **Interact:** Follow the prompts in your terminal. To end the session, ask the assistant to "quit", "exit", or "stop".

## Author
[Nidhi Yashwanth]('https://github.com/nidhiyashwanth')