import * as vscode from 'vscode';
import { JiraService } from './services/jiraService';
import { JiraIssueProvider } from './providers/issueProvider';
import { IssueDetailPanel } from './panels/issueDetailPanel';
import { CreateIssuePanel } from './panels/createIssuePanel';

export function registerCommands(
  context: vscode.ExtensionContext,
  jiraService: JiraService,
  issueProvider: JiraIssueProvider
) {
  context.subscriptions.push(
    vscode.commands.registerCommand('jira.refresh', () => {
      issueProvider.refresh();
    }),

    vscode.commands.registerCommand('jira.createIssue', () => {
      CreateIssuePanel.show(context.extensionUri, jiraService);
    }),

    vscode.commands.registerCommand('jira.openIssue', async (issueKey: string) => {
      try {
        const issue = await jiraService.getIssue(issueKey);
        IssueDetailPanel.show(context.extensionUri, issue, jiraService);
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        vscode.window.showErrorMessage(`Failed to load issue: ${msg}`);
      }
    }),

    vscode.commands.registerCommand('jira.updateStatus', async (issueKey: string) => {
      try {
        const transitions = await jiraService.getTransitions(issueKey);
        const selected = await vscode.window.showQuickPick(
          transitions.map((t) => ({ label: t.name, id: t.id })),
          { placeHolder: `Move "${issueKey}" to...` }
        );
        if (selected) {
          await jiraService.transitionIssue(issueKey, selected.id);
          vscode.window.showInformationMessage(
            `${issueKey} moved to "${selected.label}"`
          );
          issueProvider.refresh();
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        vscode.window.showErrorMessage(`Failed to update status: ${msg}`);
      }
    }),

    vscode.commands.registerCommand('jira.closeIssue', async (issueKey: string) => {
      const confirm = await vscode.window.showWarningMessage(
        `Close issue ${issueKey}?`,
        { modal: true },
        'Close'
      );
      if (confirm !== 'Close') {
        return;
      }

      try {
        const transitions = await jiraService.getTransitions(issueKey);
        const closeTransition = transitions.find(
          (t) =>
            t.name.toLowerCase().includes('done') ||
            t.name.toLowerCase().includes('close') ||
            t.name.toLowerCase().includes('resolve')
        );
        if (closeTransition) {
          await jiraService.transitionIssue(issueKey, closeTransition.id);
          vscode.window.showInformationMessage(`Issue ${issueKey} closed`);
          issueProvider.refresh();
        } else {
          vscode.window.showWarningMessage(
            'No close/done transition available. Use "Update Status" to select manually.'
          );
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        vscode.window.showErrorMessage(`Failed to close issue: ${msg}`);
      }
    }),

    vscode.commands.registerCommand('jira.configure', async () => {
      const baseUrl = await vscode.window.showInputBox({
        prompt: 'Jira Base URL',
        placeHolder: 'https://your-domain.atlassian.net',
        value: vscode.workspace.getConfiguration('jira').get('baseUrl', ''),
        ignoreFocusOut: true,
      });
      if (baseUrl === undefined) {
        return;
      }

      const username = await vscode.window.showInputBox({
        prompt: 'Jira Username (email)',
        placeHolder: 'user@example.com',
        value: vscode.workspace.getConfiguration('jira').get('username', ''),
        ignoreFocusOut: true,
      });
      if (username === undefined) {
        return;
      }

      const project = await vscode.window.showInputBox({
        prompt: 'Default Project Key',
        placeHolder: 'PROJ',
        value: vscode.workspace.getConfiguration('jira').get('project', ''),
        ignoreFocusOut: true,
      });
      if (project === undefined) {
        return;
      }

      const token = await vscode.window.showInputBox({
        prompt: 'Jira API Token',
        password: true,
        placeHolder: 'Your API token',
        ignoreFocusOut: true,
      });

      const normalizedBaseUrl = JiraService.normalizeBaseUrl(baseUrl);
      const baseUrlError = JiraService.validateBaseUrl(normalizedBaseUrl);
      if (baseUrlError) {
        vscode.window.showErrorMessage(baseUrlError);
        return;
      }

      const config = vscode.workspace.getConfiguration('jira');
      await config.update('baseUrl', normalizedBaseUrl, vscode.ConfigurationTarget.Global);
      await config.update('username', username.trim(), vscode.ConfigurationTarget.Global);
      await config.update('project', project.trim(), vscode.ConfigurationTarget.Global);

      if (token) {
        await context.secrets.store('jira.apiToken', token.trim());
      }

      vscode.window.showInformationMessage('Jira configuration saved!');
      issueProvider.refresh();
    })
  );
}
