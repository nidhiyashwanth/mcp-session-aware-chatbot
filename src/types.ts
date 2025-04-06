// src/types.ts
import {
  type ChatCompletionUserMessageParam,
  type ChatCompletionSystemMessageParam,
  type ChatCompletionAssistantMessageParam,
  type ChatCompletionToolMessageParam, // Keep for client-side logic if needed
} from "openai/resources/chat/completions";

// Represents messages stored by the MCP persistence server
export type StoredChatMessage =
  | ChatCompletionUserMessageParam
  | ChatCompletionSystemMessageParam
  | ChatCompletionAssistantMessageParam;

// Represents the full message structure potentially sent to OpenAI API by backend/client
// Includes Tool role for handling function call results if needed in complex flows
export type ChatMessageForOpenAI =
  | ChatCompletionUserMessageParam
  | ChatCompletionSystemMessageParam
  | ChatCompletionAssistantMessageParam
  | ChatCompletionToolMessageParam;

// Type for messages exchanged over our backend WebSocket proxy
export interface WebSocketMessage {
  type:
    | "sessionId"
    | "store_user_message"
    | "store_assistant_message"
    | "error"
    | "status_update"
    | "assistant_response"
    | "user_transcript";
  sessionId?: string;
  content?: string;
  message?: string; // For errors or status
}
