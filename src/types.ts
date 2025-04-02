// src/types.ts
import {
    type ChatCompletionUserMessageParam,
    type ChatCompletionSystemMessageParam,
    type ChatCompletionAssistantMessageParam,
    type ChatCompletionToolMessageParam
} from 'openai/resources/chat/completions';

// Expand ChatMessage to include Tool results for client-side handling if needed
// Although the server only stores user/assistant/system, the client constructs the full list for OpenAI
export type ChatMessage =
    | ChatCompletionUserMessageParam
    | ChatCompletionSystemMessageParam
    | ChatCompletionAssistantMessageParam
    | ChatCompletionToolMessageParam; // Added for completeness in client logic

// SessionStore definition remains the same
// It will only store user, assistant, system messages from the server's perspective
export type StoredChatMessage =
    | ChatCompletionUserMessageParam
    | ChatCompletionSystemMessageParam
    | ChatCompletionAssistantMessageParam;

export type SessionStore = Map<string, StoredChatMessage[]>;