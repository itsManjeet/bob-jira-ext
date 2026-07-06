import * as vscode from 'vscode';
import { JiraIssueProvider } from './providers/issueProvider';
import { JiraService } from './services/jiraService';
import { registerCommands } from './commands';

export function activate(context: vscode.ExtensionContext) {
  const jiraService = new JiraService(context);
  const issueProvider = new JiraIssueProvider(jiraService);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      JiraIssueProvider.viewType,
      issueProvider
    )
  );

  registerCommands(context, jiraService, issueProvider);

  // Auto-refresh on configuration change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('jira')) {
        jiraService.clearFieldCache();
        issueProvider.refresh();
      }
    })
  );
}

export function deactivate() {}
