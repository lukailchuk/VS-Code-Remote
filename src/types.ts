export interface ChatMessage {
  id: string;
  type: 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'status';
  content: string;
  timestamp: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  isError?: boolean;
}

export interface WsOutgoingMessage {
  type: 'chat_message' | 'history' | 'connection_status';
  data: ChatMessage | ChatMessage[] | { status: string };
}

export interface WsIncomingMessage {
  type: 'send_message' | 'accept' | 'reject' | 'request_history';
  text?: string;
}

export interface SessionInfo {
  sessionId: string;
  filePath: string;
  projectPath: string;
  lastModified: Date;
}
