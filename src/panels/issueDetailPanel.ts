import * as vscode from 'vscode';
import { JiraIssue } from '../models/jiraTypes';
import { JiraService } from '../services/jiraService';
import { escapeAttribute, escapeHtml, getNonce, getWebviewCsp } from '../utils/webview';

export class IssueDetailPanel {
  public static currentPanel: IssueDetailPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private issue: JiraIssue,
    private jiraService: JiraService
  ) {
    this.panel = panel;
    this.update();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'updateStatus':
            await this.handleStatusUpdate(message.issueKey);
            break;
          case 'addComment':
            await this.handleAddComment(message.issueKey, message.body);
            break;
          case 'updateSummary':
            await this.handleUpdateSummary(message.issueKey, message.summary);
            break;
          case 'updateDescription':
            await this.handleUpdateDescription(message.issueKey, message.description);
            break;
          case 'adjustStoryPoints':
            await this.handleAdjustStoryPoints(message.issueKey, Number(message.delta));
            break;
          case 'toggleSubtask':
            await this.handleToggleSubtask(message.subtaskKey, message.done);
            break;
          case 'updateSubtaskStatus':
            await this.handleSubtaskStatusUpdate(message.subtaskKey);
            break;
          case 'assignSubtaskToMe':
            await this.handleAssignSubtaskToMe(message.subtaskKey);
            break;
          case 'openIssue':
            vscode.commands.executeCommand('jira.openIssue', message.issueKey);
            break;
          case 'addSubtask':
            await this.handleAddSubtask(message.issueKey, message.summary, message.priority, message.assignee);
            break;
          case 'editSubtaskSummary':
            await this.handleEditSubtaskSummary(message.subtaskKey, message.summary);
            break;
          case 'deleteSubtask':
            await this.handleDeleteSubtask(message.subtaskKey);
            break;
          case 'openSubtask':
            vscode.commands.executeCommand('jira.openIssue', message.subtaskKey);
            break;
          case 'close':
            await this.handleClose(message.issueKey);
            break;
        }
      },
      null,
      this.disposables
    );
  }

  static show(
    extensionUri: vscode.Uri,
    issue: JiraIssue,
    jiraService: JiraService
  ) {
    const column = vscode.ViewColumn.One;

    if (IssueDetailPanel.currentPanel) {
      IssueDetailPanel.currentPanel.issue = issue;
      IssueDetailPanel.currentPanel.panel.reveal(column);
      IssueDetailPanel.currentPanel.update();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'jiraIssueDetail',
      `Jira: ${issue.key}`,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    IssueDetailPanel.currentPanel = new IssueDetailPanel(panel, issue, jiraService);
  }

  private async handleStatusUpdate(issueKey: string) {
    try {
      const transitions = await this.jiraService.getTransitions(issueKey);
      const selected = await vscode.window.showQuickPick(
        transitions.map((t) => ({ label: t.name, id: t.id })),
        { placeHolder: 'Select new status' }
      );
      if (selected) {
        await this.jiraService.transitionIssue(issueKey, selected.id);
        vscode.window.showInformationMessage(`Issue ${issueKey} moved to "${selected.label}"`);
        this.issue = await this.jiraService.getIssue(issueKey);
        this.update();
        vscode.commands.executeCommand('jira.refresh');
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to update status: ${msg}`);
    }
  }

  private async handleAddComment(issueKey: string, body: string) {
    try {
      await this.jiraService.addComment(issueKey, body);
      vscode.window.showInformationMessage(`Comment added to ${issueKey}`);
      this.issue = await this.jiraService.getIssue(issueKey);
      this.update();
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to add comment: ${msg}`);
    }
  }

  private async handleUpdateSummary(issueKey: string, summary: string) {
    try {
      await this.jiraService.updateIssue(issueKey, { summary } as any);
      vscode.window.showInformationMessage(`Issue ${issueKey} updated`);
      this.issue = await this.jiraService.getIssue(issueKey);
      this.update();
      vscode.commands.executeCommand('jira.refresh');
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to update issue: ${msg}`);
    }
  }

  private async handleUpdateDescription(issueKey: string, description: string) {
    try {
      await this.jiraService.updateIssue(issueKey, { description } as any);
      vscode.window.showInformationMessage(`Description updated for ${issueKey}`);
      this.issue = await this.jiraService.getIssue(issueKey);
      this.update();
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to update description: ${msg}`);
    }
  }

  private async handleAdjustStoryPoints(issueKey: string, delta: number) {
    if (!Number.isFinite(delta) || delta === 0) { return; }

    try {
      const nextPoints = Math.max(0, this.jiraService.getStoryPoints(this.issue) + delta);
      await this.jiraService.setStoryPoints(this.issue, nextPoints);
      vscode.window.showInformationMessage(`${issueKey} sprint points set to ${nextPoints}`);
      this.issue = await this.jiraService.getIssue(issueKey);
      this.update();
      vscode.commands.executeCommand('jira.refresh');
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to update sprint points: ${msg}`);
    }
  }

  private async handleAddSubtask(parentKey: string, summary: string, priority?: string, assignee?: string) {
    try {
      const issue = this.issue;
      const subtaskType = await this.jiraService.getSubtaskIssueType(issue.fields.project.key);
      const fields: any = {
        project: { key: issue.fields.project.key },
        summary,
        issuetype: { id: subtaskType.id },
        parent: { key: parentKey },
      };
      if (assignee) {
        fields.assignee = { name: assignee };
      }
      if (priority) {
        fields.priority = { name: priority };
      }
      await this.jiraService.createIssue({ fields } as any);
      vscode.window.showInformationMessage(`Subtask added to ${parentKey}`);
      this.issue = await this.jiraService.getIssue(parentKey);
      this.update();
      vscode.commands.executeCommand('jira.refresh');
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to create subtask: ${msg}`);
    }
  }

  private async handleEditSubtaskSummary(subtaskKey: string, summary: string) {
    try {
      await this.jiraService.updateIssue(subtaskKey, { summary } as any);
      this.issue = await this.jiraService.getIssue(this.issue.key);
      this.update();
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to update subtask: ${msg}`);
    }
  }

  private async handleDeleteSubtask(subtaskKey: string) {
    const confirm = await vscode.window.showWarningMessage(
      `Delete subtask ${subtaskKey}? This cannot be undone.`,
      { modal: true },
      'Delete'
    );
    if (confirm !== 'Delete') { return; }
    try {
      await this.jiraService.deleteIssue(subtaskKey);
      vscode.window.showInformationMessage(`Subtask ${subtaskKey} deleted`);
      this.issue = await this.jiraService.getIssue(this.issue.key);
      this.update();
      vscode.commands.executeCommand('jira.refresh');
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to delete subtask: ${msg}`);
    }
  }

  private async handleToggleSubtask(subtaskKey: string, done: boolean) {
    try {
      const transitions = await this.jiraService.getTransitions(subtaskKey);
      let target: any;
      if (done) {
        target = transitions.find(
          (t) => t.name.toLowerCase().includes('done') ||
                 t.name.toLowerCase().includes('close') ||
                 t.name.toLowerCase().includes('resolve')
        );
      } else {
        target = transitions.find(
          (t) => t.name.toLowerCase().includes('to do') ||
                 t.name.toLowerCase().includes('open') ||
                 t.name.toLowerCase().includes('reopen') ||
                 t.name.toLowerCase().includes('backlog')
        );
      }
      if (target) {
        await this.jiraService.transitionIssue(subtaskKey, target.id);
        this.issue = await this.jiraService.getIssue(this.issue.key);
        this.update();
        vscode.commands.executeCommand('jira.refresh');
      } else {
        vscode.window.showWarningMessage(`No suitable transition found for ${subtaskKey}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to update subtask: ${msg}`);
    }
  }

  private async handleSubtaskStatusUpdate(subtaskKey: string) {
    if (!subtaskKey) { return; }

    try {
      const transitions = await this.jiraService.getTransitions(subtaskKey);
      const selected = await vscode.window.showQuickPick(
        transitions.map((t) => ({ label: t.name, id: t.id })),
        { placeHolder: `Move "${subtaskKey}" to...` }
      );
      if (!selected) { return; }

      await this.jiraService.transitionIssue(subtaskKey, selected.id);
      vscode.window.showInformationMessage(`${subtaskKey} moved to "${selected.label}"`);
      this.issue = await this.jiraService.getIssue(this.issue.key);
      this.update();
      vscode.commands.executeCommand('jira.refresh');
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to update subtask status: ${msg}`);
    }
  }

  private async handleAssignSubtaskToMe(subtaskKey: string) {
    if (!subtaskKey) { return; }

    try {
      await this.jiraService.assignIssueToCurrentUser(subtaskKey);
      vscode.window.showInformationMessage(`${subtaskKey} assigned to you`);
      this.issue = await this.jiraService.getIssue(this.issue.key);
      this.update();
      vscode.commands.executeCommand('jira.refresh');
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to assign subtask: ${msg}`);
    }
  }

  private async handleClose(issueKey: string) {
    try {
      const transitions = await this.jiraService.getTransitions(issueKey);
      const closeTransition = transitions.find(
        (t) =>
          t.name.toLowerCase().includes('done') ||
          t.name.toLowerCase().includes('close') ||
          t.name.toLowerCase().includes('resolve')
      );
      if (closeTransition) {
        await this.jiraService.transitionIssue(issueKey, closeTransition.id);
        vscode.window.showInformationMessage(`Issue ${issueKey} closed`);
        this.issue = await this.jiraService.getIssue(issueKey);
        this.update();
        vscode.commands.executeCommand('jira.refresh');
      } else {
        vscode.window.showWarningMessage('No close/done transition available for this issue.');
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to close issue: ${msg}`);
    }
  }

  private getStatusColor(status: string): string {
    const lower = status.toLowerCase();
    if (lower.includes('done') || lower.includes('closed') || lower.includes('resolved')) {
      return '#4caf50';
    }
    if (lower.includes('progress')) {
      return '#ff9800';
    }
    if (lower.includes('review')) {
      return '#9c27b0';
    }
    return '#2196f3';
  }

  private getPriorityIcon(priority: string): string {
    const lower = priority.toLowerCase();
    if (lower.includes('highest') || lower.includes('critical')) { return '⬆⬆'; }
    if (lower.includes('high')) { return '⬆'; }
    if (lower.includes('medium')) { return '—'; }
    if (lower.includes('low')) { return '⬇'; }
    if (lower.includes('lowest')) { return '⬇⬇'; }
    return '—';
  }

  private update() {
    this.panel.title = `Jira: ${this.issue.key}`;
    this.panel.webview.html = this.getHtml();
  }

  private getHtml(): string {
    const issue = this.issue;
    const comments = issue.fields.comment?.comments || [];
    const subtasks = issue.fields.subtasks || [];
    const storyPoints = this.jiraService.getStoryPoints(issue);
    const statusColor = this.getStatusColor(issue.fields.status.name);
    const priorityIcon = this.getPriorityIcon(issue.fields.priority.name);
    const completedSubtasks = subtasks.filter((st: any) => {
      const status = st.fields.status.name.toLowerCase();
      return status.includes('done') || status.includes('closed') || status.includes('resolved');
    }).length;
    const parent = issue.fields.parent;
    const isSubtask = Boolean(parent);
    const nonce = getNonce();
    const csp = getWebviewCsp(this.panel.webview, nonce);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      line-height: 1.55;
    }
    .page {
      width: min(860px, 100%);
      margin: 0 auto;
      padding: 20px 24px 28px;
    }
    .issue-hero,
    .section {
      background: color-mix(in srgb, var(--vscode-editorWidget-background) 90%, transparent);
      border: 1px solid var(--vscode-widget-border, rgba(127, 127, 127, 0.2));
      border-radius: 14px;
      overflow: hidden;
    }
    .issue-hero {
      padding: 16px;
      margin-bottom: 12px;
      border-left: 3px solid var(--vscode-textLink-foreground);
    }
    .hero-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 12px;
      min-width: 0;
    }
    .breadcrumb {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      margin-bottom: 10px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .breadcrumb button {
      width: auto;
      padding: 2px 8px;
      border-radius: 999px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      font-size: 11px;
    }
    .breadcrumb button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .issue-key {
      display: inline-flex;
      align-items: center;
      min-width: 0;
      max-width: 60%;
      padding: 3px 10px;
      border-radius: 999px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.02em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .issue-project {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .summary-row {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      margin-bottom: 14px;
      min-width: 0;
    }
    .summary-row h1 {
      margin: 0;
      font-size: 1.45em;
      flex: 1;
      line-height: 1.25;
      min-width: 0;
    }
    .edit-btn {
      opacity: 0.55;
      cursor: pointer;
      flex-shrink: 0;
      border-radius: 8px;
      padding: 2px 5px;
      color: var(--vscode-descriptionForeground);
    }
    .edit-btn:hover {
      opacity: 1;
      background: var(--vscode-toolbar-hoverBackground);
      color: var(--vscode-foreground);
    }
    [data-action] { cursor: pointer; }
    .summary-input,
    .desc-edit,
    .subtask-inline-edit {
      display: none;
    }
    input,
    textarea,
    select {
      width: 100%;
      border: 1px solid var(--vscode-input-border, transparent);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 8px;
      font-family: inherit;
      font-size: inherit;
    }
    input { padding: 7px 10px; }
    textarea {
      padding: 10px;
      resize: vertical;
    }
    .summary-input input {
      font-size: 1.25em;
      font-weight: 700;
    }
    .inline-actions,
    .summary-input,
    .desc-edit {
      margin-top: 8px;
    }
    .summary-input button,
    .desc-edit button,
    .comment-form button {
      margin-top: 8px;
      margin-right: 6px;
    }

    .hero-meta,
    .card-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .hero-meta { justify-content: flex-start; }
    .meta-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      max-width: 100%;
      padding: 3px 9px;
      border-radius: 999px;
      border: 1px solid var(--vscode-widget-border, rgba(127, 127, 127, 0.2));
      background: color-mix(in srgb, var(--vscode-editorWidget-background) 62%, transparent);
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      font-weight: 600;
      line-height: 1.5;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .status-pill {
      color: var(--vscode-foreground);
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .status-button {
      width: auto;
      border-radius: 999px;
      background: color-mix(in srgb, var(--vscode-editorWidget-background) 62%, transparent);
      color: var(--vscode-foreground);
      padding: 3px 9px;
      font-size: 11px;
    }
    .status-button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .points-control {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
      margin-left: auto;
      padding: 3px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--vscode-editor-background) 70%, transparent);
      border: 1px solid var(--vscode-widget-border, rgba(127, 127, 127, 0.2));
    }
    .points-label {
      min-width: 58px;
      height: 24px;
      padding: 0 10px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      white-space: nowrap;
    }
    .points-btn {
      width: 24px;
      height: 24px;
      padding: 0;
      border-radius: 999px;
      font-size: 15px;
      line-height: 1;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .points-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }

    .section {
      margin-bottom: 12px;
      padding: 14px;
    }
    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 10px;
    }
    .section-header h2 {
      margin: 0;
      font-size: 0.82em;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--vscode-descriptionForeground);
    }
    .section-count {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      font-weight: 600;
    }
    .description {
      white-space: pre-wrap;
      padding: 12px;
      border-radius: 10px;
      background: color-mix(in srgb, var(--vscode-editor-background) 72%, transparent);
      border: 1px solid var(--vscode-widget-border, rgba(127, 127, 127, 0.16));
      font-size: 13px;
      color: var(--vscode-foreground);
    }

    .subtask-list {
      list-style: none;
      padding: 0;
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .subtask-item {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 11px 12px;
      border: 1px solid var(--vscode-widget-border, rgba(127, 127, 127, 0.16));
      border-radius: 10px;
      background: color-mix(in srgb, var(--vscode-editor-background) 72%, transparent);
      font-size: 13px;
      transition: border-color 0.12s ease, background 0.12s ease, transform 0.12s ease;
    }
    .subtask-item:hover {
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-list-hoverBackground);
      transform: translateY(-1px);
    }
    .subtask-top,
    .subtask-title-row,
    .subtask-bottom {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .subtask-top,
    .subtask-bottom { justify-content: space-between; }
    .subtask-identity,
    .subtask-meta,
    .subtask-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .subtask-key {
      display: inline-flex;
      align-items: center;
      min-width: 0;
      max-width: 160px;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid var(--vscode-widget-border, rgba(127, 127, 127, 0.2));
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.02em;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .subtask-key:hover { filter: brightness(1.1); }
    .subtask-type,
    .subtask-assignee {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }
    .subtask-status {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid var(--vscode-widget-border, rgba(127, 127, 127, 0.2));
      background: color-mix(in srgb, var(--vscode-editorWidget-background) 62%, transparent);
      color: var(--vscode-foreground);
      font-size: 11px;
      font-weight: 600;
      line-height: 1.5;
      max-width: 180px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .subtask-status-button {
      cursor: pointer;
    }
    .subtask-status-button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .subtask-item input[type="checkbox"] {
      width: 16px;
      height: 16px;
      cursor: pointer;
      accent-color: var(--vscode-textLink-foreground);
      flex-shrink: 0;
    }
    .subtask-body { min-width: 0; flex: 1; }
    .subtask-summary-row { min-width: 0; flex: 1; }
    .subtask-text {
      display: block;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
      line-height: 1.35;
    }
    .subtask-text.done {
      text-decoration: line-through;
      opacity: 0.55;
    }
    .subtask-edit-btn,
    .subtask-open-btn,
    .assign-self-btn,
    .delete-btn {
      min-width: 24px;
      height: 24px;
      padding: 0 8px;
      border-radius: 999px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      line-height: 1;
      opacity: 0.86;
      white-space: nowrap;
    }
    .subtask-edit-btn,
    .subtask-open-btn,
    .delete-btn {
      width: 24px;
      padding: 0;
    }
    .subtask-edit-btn:hover,
    .subtask-open-btn:hover,
    .assign-self-btn:hover {
      opacity: 1;
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .delete-btn {
      color: var(--vscode-errorForeground);
      background: transparent;
      border-color: transparent;
    }
    .delete-btn:hover {
      background: var(--vscode-toolbar-hoverBackground);
    }
    .subtask-priority {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      padding: 2px 7px;
      border-radius: 999px;
      border: 1px solid var(--vscode-widget-border, rgba(127, 127, 127, 0.2));
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }
    .subtask-inline-edit {
      margin-top: 8px;
      padding: 10px;
      border-radius: 10px;
      border: 1px solid var(--vscode-widget-border, rgba(127, 127, 127, 0.16));
      background: color-mix(in srgb, var(--vscode-editorWidget-background) 70%, transparent);
    }
    .subtask-inline-edit input { font-size: 12px; }
    .subtask-inline-edit-btns { margin-top: 8px; display: flex; gap: 6px; }
    .subtask-progress {
      display: inline-flex;
      align-items: center;
      padding: 3px 9px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--vscode-editor-background) 72%, transparent);
      border: 1px solid var(--vscode-widget-border, rgba(127, 127, 127, 0.16));
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 10px;
    }
    .empty-note {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
    }
    .add-subtask-toggle {
      margin-top: 10px;
      font-size: 12px;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      border-radius: 8px;
      padding: 4px 0;
    }
    .add-subtask-toggle:hover { text-decoration: underline; }
    .add-subtask-form {
      display: none;
      flex-direction: column;
      gap: 8px;
      margin-top: 8px;
      padding: 12px;
      background: color-mix(in srgb, var(--vscode-editor-background) 72%, transparent);
      border: 1px solid var(--vscode-widget-border, rgba(127, 127, 127, 0.16));
      border-radius: 10px;
    }
    .add-subtask-form select {
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      padding: 7px 10px;
    }
    .add-subtask-form label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 3px;
      display: block;
    }
    .add-subtask-row { display: flex; gap: 8px; }
    .add-subtask-row > div { flex: 1; min-width: 0; }
    .add-subtask-actions { display: flex; gap: 6px; margin-top: 2px; }

    .comment-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 10px;
    }
    .comment {
      padding: 10px 12px;
      background: color-mix(in srgb, var(--vscode-editor-background) 72%, transparent);
      border-radius: 10px;
      border: 1px solid var(--vscode-widget-border, rgba(127, 127, 127, 0.16));
    }
    .comment-header {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 5px;
    }
    .comment-author { font-weight: 700; font-size: 12px; }
    .comment-date { font-size: 11px; color: var(--vscode-descriptionForeground); }
    .comment-body { font-size: 13px; white-space: pre-wrap; }
    .comment-form textarea { min-height: 74px; }

    button {
      border: 1px solid transparent;
      border-radius: 8px;
      cursor: pointer;
      font-family: inherit;
      font-size: 12px;
      font-weight: 600;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      padding: 6px 12px;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:focus-visible,
    input:focus-visible,
    textarea:focus-visible,
    [data-action]:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    @media (max-width: 560px) {
      .page { padding: 12px; }
      .issue-hero,
      .section { border-radius: 10px; }
      .summary-row h1 { font-size: 1.25em; }
      .hero-meta { align-items: stretch; }
      .points-control { width: 100%; justify-content: space-between; margin-left: 0; }
      .subtask-top, .subtask-bottom { align-items: flex-start; }
      .subtask-actions { margin-left: auto; }
      .add-subtask-row { flex-direction: column; }
    }
  </style>
</head>
<body data-issue-key="${escapeAttribute(issue.key)}">
  <main class="page">
    <article class="issue-hero">
      ${isSubtask && parent ? `
      <div class="breadcrumb">
        <span>Subtask of</span>
        <button type="button" data-action="openIssue" data-issue-key="${escapeAttribute(parent.key)}" title="Open parent issue">${escapeHtml(parent.key)}</button>
        ${parent.fields?.summary ? `<span>${escapeHtml(parent.fields.summary)}</span>` : ''}
      </div>` : ''}
      <div class="hero-top">
        <span class="issue-key">${escapeHtml(issue.key)}</span>
        <span class="issue-project">${escapeHtml(issue.fields.project.key)} · ${escapeHtml(issue.fields.project.name)}</span>
      </div>

      <div class="summary-row" id="summaryDisplay">
        <h1 id="summaryText">${escapeHtml(issue.fields.summary)}</h1>
        <span class="edit-btn" data-action="showSummaryEdit" title="Edit summary" tabindex="0">✎</span>
      </div>
      <div class="summary-input" id="summaryEdit">
        <input type="text" id="summaryInput" value="${escapeAttribute(issue.fields.summary)}" />
        <button type="button" data-action="saveSummary">Save</button>
        <button class="secondary" type="button" data-action="cancelSummaryEdit">Cancel</button>
      </div>

      <div class="hero-meta">
        <button class="meta-pill status-pill status-button" type="button" data-action="changeStatus" title="Change status">
          <span class="status-dot" style="background:${statusColor};"></span>
          ${escapeHtml(issue.fields.status.name)}
        </button>
        <span class="meta-pill">${escapeHtml(priorityIcon)} ${escapeHtml(issue.fields.priority.name)}</span>
        <span class="meta-pill">${escapeHtml(issue.fields.issuetype.name)}</span>
        <span class="points-control" aria-label="Sprint points assigned">
          <button class="points-btn" type="button" data-action="adjustStoryPoints" data-delta="-1" title="Decrease sprint points" aria-label="Decrease sprint points">−</button>
          <span class="points-label">${escapeHtml(storyPoints)} pts</span>
          <button class="points-btn" type="button" data-action="adjustStoryPoints" data-delta="1" title="Increase sprint points" aria-label="Increase sprint points">+</button>
        </span>
      </div>
    </article>

    <section class="section">
      <div class="section-header">
        <h2>Description</h2>
        <span class="edit-btn" data-action="showDescEdit" title="Edit description" tabindex="0">✎</span>
      </div>
      <div class="description" id="descDisplay">${issue.fields.description ? escapeHtml(issue.fields.description) : '<span class="empty-note">No description</span>'}</div>
      <div class="desc-edit" id="descEdit">
        <textarea id="descInput">${issue.fields.description ? escapeHtml(issue.fields.description) : ''}</textarea>
        <button type="button" data-action="saveDescription">Save</button>
        <button class="secondary" type="button" data-action="cancelDescEdit">Cancel</button>
      </div>
    </section>

    ${!isSubtask ? `
    <section class="section">
      <div class="section-header">
        <h2>Subtasks</h2>
        <span class="section-count">${completedSubtasks} / ${subtasks.length} done</span>
      </div>
      ${subtasks.length > 0 ? `
      <ul class="subtask-list">
        ${subtasks.map((st: any) => {
          const isDone = st.fields.status.name.toLowerCase().includes('done') ||
                         st.fields.status.name.toLowerCase().includes('closed') ||
                         st.fields.status.name.toLowerCase().includes('resolved');
          const priority: string = st.fields.priority?.name || 'Medium';
          const assigneeName: string = st.fields.assignee?.displayName || '';
          const isUnassigned = !st.fields.assignee;
          const priorityClass = `priority-${priority.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}`;
          const subtaskStatusColor = this.getStatusColor(st.fields.status.name);
          return `<li class="subtask-item" id="st-${escapeAttribute(st.key)}">
            <div class="subtask-top">
              <div class="subtask-identity">
                <span class="subtask-key" data-action="openSubtask" data-subtask-key="${escapeAttribute(st.key)}" title="Open ${escapeAttribute(st.key)}">${escapeHtml(st.key)}</span>
                <span class="subtask-type">Sub-task</span>
              </div>
              <span class="subtask-status subtask-status-button" data-action="updateSubtaskStatus" data-subtask-key="${escapeAttribute(st.key)}" title="Change status">
                <span class="status-dot" style="background:${subtaskStatusColor};"></span>${escapeHtml(st.fields.status.name)}
              </span>
            </div>
            <div class="subtask-title-row">
              <input type="checkbox" ${isDone ? 'checked' : ''} data-action="toggleSubtask" data-subtask-key="${escapeAttribute(st.key)}" aria-label="Toggle ${escapeAttribute(st.key)}" />
              <div class="subtask-body">
                <div class="subtask-summary-row">
                  <span class="subtask-text ${isDone ? 'done' : ''}" id="st-text-${escapeAttribute(st.key)}">${escapeHtml(st.fields.summary)}</span>
                </div>
                <div class="subtask-inline-edit" id="st-edit-${escapeAttribute(st.key)}">
                  <input type="text" id="st-input-${escapeAttribute(st.key)}" value="${escapeAttribute(st.fields.summary)}" />
                  <div class="subtask-inline-edit-btns">
                    <button type="button" data-action="saveSubtaskEdit" data-subtask-key="${escapeAttribute(st.key)}">Save</button>
                    <button class="secondary" type="button" data-action="cancelSubtaskEdit" data-subtask-key="${escapeAttribute(st.key)}">Cancel</button>
                  </div>
                </div>
              </div>
            </div>
            <div class="subtask-bottom">
              <div class="subtask-meta">
                <span class="subtask-priority ${escapeAttribute(priorityClass)}">${escapeHtml(priority)}</span>
                ${assigneeName ? `<span class="subtask-assignee">@${escapeHtml(assigneeName)}</span>` : '<span class="subtask-assignee">Unassigned</span>'}
              </div>
              <div class="subtask-actions">
                ${isUnassigned ? `<button class="assign-self-btn" type="button" data-action="assignSubtaskToMe" data-subtask-key="${escapeAttribute(st.key)}" title="Assign subtask to me">Assign to me</button>` : ''}
                <button class="subtask-open-btn" type="button" data-action="openSubtask" data-subtask-key="${escapeAttribute(st.key)}" title="Open full subtask page for description and comments">↗</button>
                <button class="subtask-edit-btn" type="button" data-action="showSubtaskEdit" data-subtask-key="${escapeAttribute(st.key)}" title="Edit summary">✎</button>
                <button class="delete-btn" type="button" data-action="deleteSubtask" data-subtask-key="${escapeAttribute(st.key)}" title="Delete subtask">✕</button>
              </div>
            </div>
          </li>`;
        }).join('')}
      </ul>
      <div class="subtask-progress">${completedSubtasks} / ${subtasks.length} completed</div>` : `<div class="empty-note">No subtasks yet.</div>`}

      <span class="add-subtask-toggle" data-action="toggleAddSubtaskForm">＋ Add subtask</span>
      <div class="add-subtask-form" id="addSubtaskForm">
        <div>
          <label>Summary *</label>
          <input type="text" id="newSubtaskSummary" placeholder="Subtask summary..." />
        </div>
        <div class="add-subtask-row">
          <div>
            <label>Priority</label>
            <select id="newSubtaskPriority">
              <option value="">— default —</option>
              <option value="Highest">Highest</option>
              <option value="High">High</option>
              <option value="Medium" selected>Medium</option>
              <option value="Low">Low</option>
              <option value="Lowest">Lowest</option>
            </select>
          </div>
          <div>
            <label>Assignee (optional)</label>
            <input type="text" id="newSubtaskAssignee" placeholder="Leave blank for unassigned" />
          </div>
        </div>
        <div class="add-subtask-actions">
          <button type="button" data-action="addSubtask">Create Subtask</button>
          <button class="secondary" type="button" data-action="toggleAddSubtaskForm">Cancel</button>
        </div>
      </div>
    </section>` : ''}

    <section class="section">
      <div class="section-header">
        <h2>Comments</h2>
        <span class="section-count">${comments.length}</span>
      </div>
      ${comments.length > 0 ? `<div class="comment-list">
        ${comments.map((c) => `
          <div class="comment">
            <div class="comment-header">
              <span class="comment-author">${escapeHtml(c.author.displayName)}</span>
              <span class="comment-date">${escapeHtml(new Date(c.created).toLocaleString())}</span>
            </div>
            <div class="comment-body">${escapeHtml(c.body)}</div>
          </div>`).join('')}
      </div>` : `<div class="empty-note">No comments yet.</div>`}
      <div class="comment-form">
        <textarea id="commentBody" placeholder="Write a comment..."></textarea>
        <button type="button" data-action="addComment">Add Comment</button>
      </div>
    </section>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const issueKey = document.body.dataset.issueKey;

    function requireElement(id) {
      const element = document.getElementById(id);
      if (!element) {
        throw new Error('Missing element: ' + id);
      }
      return element;
    }

    // Summary edit
    function showSummaryEdit() {
      requireElement('summaryDisplay').style.display = 'none';
      requireElement('summaryEdit').style.display = 'block';
      requireElement('summaryInput').focus();
    }
    function cancelSummaryEdit() {
      requireElement('summaryDisplay').style.display = 'flex';
      requireElement('summaryEdit').style.display = 'none';
    }
    function saveSummary() {
      const summary = requireElement('summaryInput').value.trim();
      if (summary) {
        vscode.postMessage({ command: 'updateSummary', issueKey, summary });
      }
    }

    // Status
    function changeStatus() {
      vscode.postMessage({ command: 'updateStatus', issueKey });
    }
    // Description edit
    function showDescEdit() {
      requireElement('descDisplay').style.display = 'none';
      requireElement('descEdit').style.display = 'block';
      requireElement('descInput').focus();
    }
    function cancelDescEdit() {
      requireElement('descDisplay').style.display = 'block';
      requireElement('descEdit').style.display = 'none';
    }
    function saveDescription() {
      const description = requireElement('descInput').value;
      vscode.postMessage({ command: 'updateDescription', issueKey, description });
    }

    // Sprint points
    function adjustStoryPoints(delta) {
      if (!Number.isFinite(delta) || delta === 0) { return; }
      vscode.postMessage({ command: 'adjustStoryPoints', issueKey, delta });
    }

    // Subtasks
    function toggleSubtask(subtaskKey, done) {
      vscode.postMessage({ command: 'toggleSubtask', subtaskKey, done });
    }
    function toggleAddSubtaskForm() {
      const form = requireElement('addSubtaskForm');
      const visible = form.style.display === 'flex';
      form.style.display = visible ? 'none' : 'flex';
      if (!visible) {
        requireElement('newSubtaskSummary').focus();
      }
    }
    function addSubtask() {
      const summary = requireElement('newSubtaskSummary').value.trim();
      const priority = requireElement('newSubtaskPriority').value;
      const assignee = requireElement('newSubtaskAssignee').value.trim();
      if (!summary) {
        requireElement('newSubtaskSummary').focus();
        return;
      }
      vscode.postMessage({ command: 'addSubtask', issueKey, summary, priority: priority || undefined, assignee: assignee || undefined });
    }
    function showSubtaskEdit(key) {
      requireElement('st-edit-' + key).style.display = 'block';
      const row = document.querySelector('#st-' + key + ' .subtask-summary-row');
      if (row) { row.style.display = 'none'; }
      const input = requireElement('st-input-' + key);
      input.focus();
      input.select();
    }
    function cancelSubtaskEdit(key) {
      requireElement('st-edit-' + key).style.display = 'none';
      const row = document.querySelector('#st-' + key + ' .subtask-summary-row');
      if (row) { row.style.display = 'flex'; }
    }
    function saveSubtaskEdit(key) {
      const summary = requireElement('st-input-' + key).value.trim();
      if (summary) {
        vscode.postMessage({ command: 'editSubtaskSummary', subtaskKey: key, summary });
      }
    }
    function deleteSubtask(key) {
      vscode.postMessage({ command: 'deleteSubtask', subtaskKey: key });
    }
    function openSubtask(key) {
      vscode.postMessage({ command: 'openSubtask', subtaskKey: key });
    }
    function updateSubtaskStatus(key) {
      vscode.postMessage({ command: 'updateSubtaskStatus', subtaskKey: key });
    }
    function assignSubtaskToMe(key) {
      vscode.postMessage({ command: 'assignSubtaskToMe', subtaskKey: key });
    }
    function openIssue(key) {
      vscode.postMessage({ command: 'openIssue', issueKey: key });
    }

    // Comments
    function addComment() {
      const body = requireElement('commentBody').value.trim();
      if (body) {
        vscode.postMessage({ command: 'addComment', issueKey, body });
        requireElement('commentBody').value = '';
      }
    }

    document.addEventListener('click', (event) => {
      const target = event.target.closest('[data-action]');
      if (!target) { return; }

      const action = target.dataset.action;
      const subtaskKey = target.dataset.subtaskKey;
      switch (action) {
        case 'showSummaryEdit':
          showSummaryEdit();
          break;
        case 'saveSummary':
          saveSummary();
          break;
        case 'cancelSummaryEdit':
          cancelSummaryEdit();
          break;
        case 'changeStatus':
          changeStatus();
          break;
        case 'showDescEdit':
          showDescEdit();
          break;
        case 'saveDescription':
          saveDescription();
          break;
        case 'cancelDescEdit':
          cancelDescEdit();
          break;
        case 'adjustStoryPoints':
          adjustStoryPoints(Number(target.dataset.delta || 0));
          break;
        case 'toggleAddSubtaskForm':
          toggleAddSubtaskForm();
          break;
        case 'addSubtask':
          addSubtask();
          break;
        case 'showSubtaskEdit':
          if (subtaskKey) { showSubtaskEdit(subtaskKey); }
          break;
        case 'saveSubtaskEdit':
          if (subtaskKey) { saveSubtaskEdit(subtaskKey); }
          break;
        case 'cancelSubtaskEdit':
          if (subtaskKey) { cancelSubtaskEdit(subtaskKey); }
          break;
        case 'deleteSubtask':
          if (subtaskKey) { deleteSubtask(subtaskKey); }
          break;
        case 'openSubtask':
          if (subtaskKey) { openSubtask(subtaskKey); }
          break;
        case 'updateSubtaskStatus':
          if (subtaskKey) { updateSubtaskStatus(subtaskKey); }
          break;
        case 'assignSubtaskToMe':
          if (subtaskKey) { assignSubtaskToMe(subtaskKey); }
          break;
        case 'openIssue':
          if (target.dataset.issueKey) { openIssue(target.dataset.issueKey); }
          break;
        case 'addComment':
          addComment();
          break;
      }
    });

    document.addEventListener('change', (event) => {
      const target = event.target.closest('[data-action="toggleSubtask"]');
      if (!target) { return; }
      toggleSubtask(target.dataset.subtaskKey, target.checked);
    });
  </script>
</body>
</html>`;
  }

  private dispose() {
    IssueDetailPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}
