import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import { SessionInfo } from '../types';

export class SessionFinder extends EventEmitter {
  private claudeProjectsDir: string;
  private watcher: fs.FSWatcher | null = null;

  constructor() {
    super();
    this.claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
  }

  /**
   * Encode workspace path to Claude Code's directory naming format.
   * Replaces `/` and spaces with `-`.
   * e.g. `/Users/lukailchuk/Projects/AI Marketing` → `-Users-lukailchuk-Projects-AI-Marketing`
   */
  encodeProjectPath(workspacePath: string): string {
    return workspacePath.replace(/[\/ ]/g, '-');
  }

  /**
   * Find the most recent session JSONL file for a given workspace path.
   * Looks in `~/.claude/projects/<encoded-path>/` for .jsonl files (top-level only).
   * Returns the one with the most recent mtime.
   */
  async findCurrentSession(workspacePath: string): Promise<SessionInfo | null> {
    const encoded = this.encodeProjectPath(workspacePath);
    const projectDir = path.join(this.claudeProjectsDir, encoded);

    try {
      await fs.promises.access(projectDir, fs.constants.R_OK);
    } catch {
      return null;
    }

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(projectDir, { withFileTypes: true });
    } catch {
      return null;
    }

    // Only top-level .jsonl files — skip directories like subagents/
    const jsonlFiles = entries.filter(
      (entry) => entry.isFile() && entry.name.endsWith('.jsonl')
    );

    if (jsonlFiles.length === 0) {
      return null;
    }

    // Get stats for each file and sort by mtime descending
    const fileStats: Array<{ name: string; fullPath: string; mtime: Date }> = [];

    for (const file of jsonlFiles) {
      const fullPath = path.join(projectDir, file.name);
      try {
        const stat = await fs.promises.stat(fullPath);
        fileStats.push({
          name: file.name,
          fullPath,
          mtime: stat.mtime,
        });
      } catch {
        // File might have been deleted between readdir and stat — skip it
        continue;
      }
    }

    if (fileStats.length === 0) {
      return null;
    }

    fileStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    const mostRecent = fileStats[0];
    // Session ID is the filename without extension
    const sessionId = path.basename(mostRecent.name, '.jsonl');

    return {
      sessionId,
      filePath: mostRecent.fullPath,
      projectPath: workspacePath,
      lastModified: mostRecent.mtime,
    };
  }

  /**
   * List all sessions for a given workspace, sorted by mtime descending.
   */
  async listSessions(workspacePath: string): Promise<SessionInfo[]> {
    const encoded = this.encodeProjectPath(workspacePath);
    const projectDir = path.join(this.claudeProjectsDir, encoded);

    try {
      await fs.promises.access(projectDir, fs.constants.R_OK);
    } catch {
      return [];
    }

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(projectDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const jsonlFiles = entries.filter(
      (entry) => entry.isFile() && entry.name.endsWith('.jsonl')
    );

    const sessions: SessionInfo[] = [];

    for (const file of jsonlFiles) {
      const fullPath = path.join(projectDir, file.name);
      try {
        const stat = await fs.promises.stat(fullPath);
        sessions.push({
          sessionId: path.basename(file.name, '.jsonl'),
          filePath: fullPath,
          projectPath: workspacePath,
          lastModified: stat.mtime,
        });
      } catch {
        continue;
      }
    }

    sessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

    return sessions;
  }

  /**
   * Watch the project directory for new .jsonl session files.
   * Emits 'new-session' with a SessionInfo when a new file appears.
   */
  watchForNewSessions(workspacePath: string): void {
    // Clean up any existing watcher
    this.stopWatching();

    const encoded = this.encodeProjectPath(workspacePath);
    const projectDir = path.join(this.claudeProjectsDir, encoded);

    // Track known files so we can detect new ones
    const knownFiles = new Set<string>();

    // Populate known files from current state
    try {
      const entries = fs.readdirSync(projectDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          knownFiles.add(entry.name);
        }
      }
    } catch {
      // Directory might not exist yet — that's fine, we'll watch for it
      // But fs.watch requires the directory to exist, so bail out
      return;
    }

    try {
      this.watcher = fs.watch(projectDir, (eventType, filename) => {
        if (!filename || !filename.endsWith('.jsonl')) {
          return;
        }

        // We only care about new files (rename event = create or delete on macOS)
        if (eventType === 'rename' && !knownFiles.has(filename)) {
          const fullPath = path.join(projectDir, filename);

          // Verify the file actually exists (rename fires for both create and delete)
          fs.stat(fullPath, (err, stat) => {
            if (err) {
              // File was deleted — remove from known if present
              knownFiles.delete(filename);
              return;
            }

            knownFiles.add(filename);

            const sessionInfo: SessionInfo = {
              sessionId: path.basename(filename, '.jsonl'),
              filePath: fullPath,
              projectPath: workspacePath,
              lastModified: stat.mtime,
            };

            this.emit('new-session', sessionInfo);
          });
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
   * Stop watching for new sessions.
   */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Dispose all resources.
   */
  dispose(): void {
    this.stopWatching();
    this.removeAllListeners();
  }
}
