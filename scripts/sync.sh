#!/bin/bash
# sync.sh — Extract all CLI (mobile) messages from the current session JSONL
# Usage: ./scripts/sync.sh [session-jsonl-path]
#
# If no path provided, finds the most recent JSONL in the current project's .claude dir.

set -euo pipefail

CLAUDE_PROJECTS="$HOME/.claude/projects"

if [[ -n "${1:-}" ]]; then
  JSONL_FILE="$1"
else
  # Derive project key from current directory
  PROJECT_KEY=$(pwd | sed 's|[/ ]|-|g')
  PROJECT_DIR="$CLAUDE_PROJECTS/$PROJECT_KEY"

  if [[ ! -d "$PROJECT_DIR" ]]; then
    echo "ERROR: No Claude project found for $(pwd)" >&2
    exit 1
  fi

  # Find most recent JSONL
  JSONL_FILE=$(ls -t "$PROJECT_DIR"/*.jsonl 2>/dev/null | head -1)

  if [[ -z "$JSONL_FILE" ]]; then
    echo "ERROR: No JSONL files found in $PROJECT_DIR" >&2
    exit 1
  fi
fi

if [[ ! -f "$JSONL_FILE" ]]; then
  echo "ERROR: File not found: $JSONL_FILE" >&2
  exit 1
fi

# Extract CLI messages with full content
python3 -c "
import sys, json

messages = []
for line in open('$JSONL_FILE'):
    try:
        d = json.loads(line.strip())
        entry = d.get('entrypoint', '')
        if entry != 'cli':
            continue
        msg = d.get('message', {})
        role = msg.get('role', '')
        content = msg.get('content', '')
        ts = d.get('timestamp', '')

        if isinstance(content, list):
            parts = []
            for c in content:
                if c.get('type') == 'text':
                    parts.append(c['text'])
                elif c.get('type') == 'tool_use':
                    parts.append(f\"[Tool: {c.get('name','')}]\")
                elif c.get('type') == 'tool_result':
                    result = c.get('content','')
                    if isinstance(result, list):
                        result = ' '.join(r.get('text','') for r in result if r.get('type')=='text')
                    parts.append(f\"[Result: {str(result)[:100]}]\")
            content = '\n'.join(parts)

        if not content or not content.strip():
            continue

        messages.append({
            'role': role,
            'content': content.strip(),
            'timestamp': ts
        })
    except:
        continue

if not messages:
    print('No CLI (mobile) messages found in this session.')
    sys.exit(0)

print(f'=== {len(messages)} CLI messages found ===')
print()
for m in messages:
    role_label = 'USER (mobile)' if m['role'] == 'user' else 'CLAUDE (terminal)'
    ts = m['timestamp'][:19].replace('T', ' ') if m['timestamp'] else ''
    print(f'--- {role_label} [{ts}] ---')
    print(m['content'])
    print()
"