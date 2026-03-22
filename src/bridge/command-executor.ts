import * as vscode from 'vscode';

export class CommandExecutor {

  async acceptChanges(): Promise<boolean> {
    try {
      await vscode.commands.executeCommand('claude-code.acceptProposedDiff');
      return true;
    } catch (error) {
      console.error('Failed to accept changes:', error);
      return false;
    }
  }

  async rejectChanges(): Promise<boolean> {
    try {
      await vscode.commands.executeCommand('claude-code.rejectProposedDiff');
      return true;
    } catch (error) {
      console.error('Failed to reject changes:', error);
      return false;
    }
  }
}
