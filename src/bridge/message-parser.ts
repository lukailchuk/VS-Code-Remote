import { ChatMessage } from '../types';

/**
 * Shape of a single content block inside `message.content` arrays
 * from Claude Code's JSONL format.
 */
interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  content?: string | ContentBlock[];
  tool_use_id?: string;
  is_error?: boolean;
}

/**
 * Shape of a single JSONL line from a Claude Code session file.
 * We only define the fields we actually use.
 */
interface JsonlEntry {
  type?: string;
  uuid?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
}

/**
 * Generate a deterministic-ish ID from uuid + index.
 * Falls back to timestamp-based if uuid is missing.
 */
function makeId(uuid: string | undefined, suffix: string): string {
  if (uuid) {
    return `${uuid}-${suffix}`;
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${suffix}`;
}

/**
 * Format a tool input object into a readable string for display.
 */
function formatToolInput(input: Record<string, unknown>): string {
  // For Bash commands, show the command directly
  if (typeof input['command'] === 'string') {
    return input['command'];
  }
  // For file operations, show the path
  if (typeof input['file_path'] === 'string') {
    return input['file_path'] as string;
  }
  // For search/grep, show the pattern
  if (typeof input['pattern'] === 'string') {
    return `pattern: ${input['pattern']}`;
  }
  // Fallback: compact JSON
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return '[complex input]';
  }
}

/**
 * Extract text from a tool_result content field.
 * Content can be a string or an array of content blocks.
 */
function extractToolResultContent(
  content: string | ContentBlock[] | undefined
): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block.type === 'text' && block.text) {
          return block.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

const SKIP_ENTRY_TYPES = new Set(['queue-operation', 'file-history-snapshot']);

/**
 * Parse a single JSONL line from a Claude Code session file into
 * zero or more ChatMessage objects.
 *
 * Returns an empty array for lines that should be skipped
 * (e.g., queue-operation, file-history-snapshot, thinking blocks).
 */
export function parseJsonlLine(line: string): ChatMessage[] {
  const trimmed = line.trim();
  if (!trimmed) {
    return [];
  }

  let entry: JsonlEntry;
  try {
    entry = JSON.parse(trimmed) as JsonlEntry;
  } catch {
    return [];
  }

  if (!entry.type || !entry.message) {
    return [];
  }

  if (SKIP_ENTRY_TYPES.has(entry.type)) {
    return [];
  }

  const timestamp = entry.timestamp ?? new Date().toISOString();
  const role = entry.message.role;
  const content = entry.message.content;
  const messages: ChatMessage[] = [];

  // ── User messages ──
  if (entry.type === 'user' && role === 'user') {
    if (typeof content === 'string') {
      messages.push({
        id: makeId(entry.uuid, 'user'),
        type: 'user',
        content,
        timestamp,
      });
    } else if (Array.isArray(content)) {
      let textParts: string[] = [];

      for (let i = 0; i < content.length; i++) {
        const block = content[i];

        if (block.type === 'text' && block.text) {
          textParts.push(block.text);
        } else if (block.type === 'tool_result') {
          // Flush any accumulated text first
          if (textParts.length > 0) {
            messages.push({
              id: makeId(entry.uuid, `user-text-${i}`),
              type: 'user',
              content: textParts.join('\n'),
              timestamp,
            });
            textParts = [];
          }

          const resultContent = extractToolResultContent(block.content);
          messages.push({
            id: makeId(entry.uuid, `tool-result-${i}`),
            type: 'tool_result',
            content: resultContent,
            timestamp,
            toolName: block.tool_use_id ?? undefined,
            isError: block.is_error ?? false,
          });
        }
      }

      // Flush remaining text
      if (textParts.length > 0) {
        messages.push({
          id: makeId(entry.uuid, 'user-text'),
          type: 'user',
          content: textParts.join('\n'),
          timestamp,
        });
      }
    }

    return messages;
  }

  // ── Assistant messages ──
  if (entry.type === 'assistant' && role === 'assistant') {
    if (typeof content === 'string') {
      // Simple string content (rare for assistant, but handle it)
      messages.push({
        id: makeId(entry.uuid, 'assistant'),
        type: 'assistant',
        content,
        timestamp,
      });
    } else if (Array.isArray(content)) {
      let textParts: string[] = [];

      for (let i = 0; i < content.length; i++) {
        const block = content[i];

        if (block.type === 'text' && block.text) {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          // Flush accumulated text before the tool call
          if (textParts.length > 0) {
            messages.push({
              id: makeId(entry.uuid, `assistant-text-${i}`),
              type: 'assistant',
              content: textParts.join('\n'),
              timestamp,
            });
            textParts = [];
          }

          const toolInput = (block.input ?? {}) as Record<string, unknown>;
          messages.push({
            id: makeId(entry.uuid, `tool-call-${i}`),
            type: 'tool_call',
            content: formatToolInput(toolInput),
            timestamp,
            toolName: block.name ?? 'unknown',
            toolInput,
          });
        } else if (block.type === 'thinking') {
          // Skip thinking blocks — they're internal reasoning
          // Could emit as 'status' if we ever want to show them:
          // messages.push({ ..., type: 'status', content: 'Thinking...' })
          continue;
        }
      }

      // Flush remaining text
      if (textParts.length > 0) {
        messages.push({
          id: makeId(entry.uuid, 'assistant-text'),
          type: 'assistant',
          content: textParts.join('\n'),
          timestamp,
        });
      }
    }

    return messages;
  }

  // Unknown entry type/role combo — skip
  return messages;
}
