import * as fs from 'fs';
import { EventEmitter } from 'events';
import { ChatMessage } from '../types';
import { parseJsonlLine } from './message-parser';

/**
 * Watches a JSONL session file for new lines and emits parsed ChatMessage objects.
 *
 * Events:
 *  - 'message' (ChatMessage)  — fired for each new message parsed from appended lines
 *  - 'history' (ChatMessage[]) — fired once on start with all existing messages
 *  - 'error'   (Error)         — fired on read/watch errors
 */
const MAX_HISTORY_SIZE = 2000;

export class JsonlWatcher extends EventEmitter {
  private filePath: string;
  private offset: number = 0;
  private watcher: fs.FSWatcher | null = null;
  private history: ChatMessage[] = [];
  private isProcessing: boolean = false;
  private pendingRead: boolean = false;
  private lineBuffer: string = '';

  constructor(filePath: string) {
    super();
    this.filePath = filePath;
  }

  /**
   * Start watching the JSONL file.
   * 1. Reads all existing content and emits 'history'.
   * 2. Sets offset to end of file.
   * 3. Begins watching for new appended data.
   */
  async start(): Promise<void> {
    let existingContent: string;

    try {
      existingContent = await fs.promises.readFile(this.filePath, 'utf-8');
    } catch {
      this.emit('error', new Error(`Failed to read session file: ${this.filePath}`));
      return;
    }

    // Parse existing content into history
    const lines = existingContent.split('\n');
    for (const line of lines) {
      if (line.trim()) {
        const messages = parseJsonlLine(line);
        this.history.push(...messages);
      }
    }

    // Set offset from content byte length (avoids separate stat call)
    this.offset = Buffer.byteLength(existingContent, 'utf-8');

    // Emit history
    this.emit('history', [...this.history]);

    // Start watching for changes
    this.startWatching();
  }

  /**
   * Begin fs.watch on the session file.
   */
  private startWatching(): void {
    try {
      this.watcher = fs.watch(this.filePath, (eventType) => {
        if (eventType === 'change') {
          this.scheduleRead();
        }
      });

      this.watcher.on('error', (error) => {
        this.emit('error', error);
      });
    } catch (error) {
      this.emit('error', error);
    }
  }

  /**
   * Debounce/coalesce rapid change events into a single read.
   * fs.watch can fire multiple events for a single write operation.
   */
  private scheduleRead(): void {
    if (this.isProcessing) {
      // We're already reading — mark that another read is needed after
      this.pendingRead = true;
      return;
    }

    this.readNewData();
  }

  /**
   * Read any new bytes appended after our current offset, parse them,
   * and emit messages.
   */
  private async readNewData(): Promise<void> {
    this.isProcessing = true;

    try {
      const stat = await fs.promises.stat(this.filePath);
      const currentSize = stat.size;

      if (currentSize <= this.offset) {
        if (currentSize < this.offset) {
          this.offset = currentSize;
          this.lineBuffer = '';
        }
        this.isProcessing = false;
        this.checkPending();
        return;
      }

      const bytesToRead = currentSize - this.offset;
      const buffer = Buffer.alloc(bytesToRead);
      const fileHandle = await fs.promises.open(this.filePath, 'r');

      try {
        await fileHandle.read(buffer, 0, bytesToRead, this.offset);
      } finally {
        await fileHandle.close();
      }

      this.offset = currentSize;
      const newData = buffer.toString('utf-8');

      this.processNewData(newData);
    } catch (err) {
      this.emit('error', err);
    } finally {
      this.isProcessing = false;
      this.checkPending();
    }
  }

  /**
   * If a read was requested while we were processing, do another read now.
   */
  private checkPending(): void {
    if (this.pendingRead) {
      this.pendingRead = false;
      this.readNewData();
    }
  }

  /**
   * Process raw string data: split into lines, handle partial lines,
   * parse complete lines and emit messages.
   */
  private processNewData(data: string): void {
    // Prepend any buffered partial line from previous read
    const combined = this.lineBuffer + data;
    const lines = combined.split('\n');

    // The last element might be an incomplete line (no trailing newline yet)
    // Save it in the buffer for next time
    this.lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      const messages = parseJsonlLine(line);

      for (const msg of messages) {
        this.history.push(msg);
        if (this.history.length > MAX_HISTORY_SIZE) {
          this.history = this.history.slice(-MAX_HISTORY_SIZE);
        }
        this.emit('message', msg);
      }
    }
  }

  /**
   * Get all messages parsed so far (history + live messages).
   */
  getHistory(): ChatMessage[] {
    return [...this.history];
  }

  /**
   * Get the path of the file being watched.
   */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Stop watching and clean up all resources.
   */
  dispose(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.lineBuffer = '';
    this.removeAllListeners();
  }
}
