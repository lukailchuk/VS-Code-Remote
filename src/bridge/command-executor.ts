import * as vscode from 'vscode';

export class CommandExecutor {

  async acceptChanges(): Promise<void> {
    await vscode.commands.executeCommand('claude-code.acceptProposedDiff');
  }

  async rejectChanges(): Promise<void> {
    await vscode.commands.executeCommand('claude-code.rejectProposedDiff');
  }
}
