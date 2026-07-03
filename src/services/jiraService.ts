import * as vscode from 'vscode';
import {
  JiraIssue,
  JiraTransition,
  CreateIssueRequest,
  JiraProject,
  SprintInfo,
} from '../models/jiraTypes';

export class JiraService {
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  private getConfig() {
    const config = vscode.workspace.getConfiguration('jira');
    return {
      baseUrl: config.get<string>('baseUrl', '').replace(/\/$/, ''),
      username: config.get<string>('username', ''),
      project: config.get<string>('project', ''),
      storyPointsField: config.get<string>('storyPointsField', 'story_points'),
    };
  }

  getStoryPoints(issue: JiraIssue): number {
    const { storyPointsField } = this.getConfig();
    const fields = issue.fields as any;
    // Try configured field first, then common alternatives
    return fields[storyPointsField]
      ?? fields.story_points
      ?? fields.customfield_10016
      ?? fields.customfield_10028
      ?? fields.customfield_10024
      ?? 0;
  }

  private async getApiToken(): Promise<string | undefined> {
    let token = await this.context.secrets.get('jira.apiToken');
    if (!token) {
      token = await vscode.window.showInputBox({
        prompt: 'Enter your Jira API token',
        password: true,
        placeHolder: 'API Token',
        ignoreFocusOut: true,
      });
      if (token) {
        await this.context.secrets.store('jira.apiToken', token);
      }
    }
    return token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const { baseUrl, username } = this.getConfig();

    if (!baseUrl || !username) {
      throw new Error(
        'Jira is not configured. Please set baseUrl and username in settings.'
      );
    }

    const token = await this.getApiToken();
    if (!token) {
      throw new Error('API token is required.');
    }

    const auth = Buffer.from(`${username}:${token}`).toString('base64');

    const url = `${baseUrl}/rest/api/2${path}`;
    const headers: Record<string, string> = {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    const options: RequestInit = { method, headers };
    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorText = await response.text();
      let message = `Jira API error (${response.status})`;
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.errorMessages?.length) {
          message = errorJson.errorMessages.join(', ');
        } else if (errorJson.errors) {
          message = Object.values(errorJson.errors).join(', ');
        }
      } catch {
        message = errorText || message;
      }
      throw new Error(message);
    }

    const text = await response.text();
    return text ? JSON.parse(text) : ({} as T);
  }

  async getMyIssues(): Promise<JiraIssue[]> {
    const { storyPointsField } = this.getConfig();
    const jql = 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC';
    const fields = `summary,status,priority,issuetype,assignee,reporter,description,created,updated,project,labels,story_points,customfield_10016,customfield_10028,customfield_10024,customfield_10020,sprint,${storyPointsField}`;
    const result = await this.request<{ issues: JiraIssue[] }>(
      'GET',
      `/search?jql=${encodeURIComponent(jql)}&maxResults=50&fields=${fields}`
    );
    return result.issues;
  }

  async getSprintData(): Promise<{ issues: JiraIssue[]; sprint: SprintInfo }> {
    const issues = await this.getMyIssues();
    const sprint = this.extractSprintInfo(issues);
    return { issues, sprint };
  }

  private extractSprintInfo(issues: JiraIssue[]): SprintInfo {
    // Try to find active sprint from issue fields
    let activeSprint: any = null;
    for (const issue of issues) {
      const fields = issue.fields as any;

      // Jira Cloud: customfield_10020 is an array of sprint objects
      const sprints = fields.customfield_10020;
      if (Array.isArray(sprints) && sprints.length > 0) {
        activeSprint = sprints.find((s: any) => s.state === 'active') || sprints[sprints.length - 1];
        if (activeSprint) { break; }
      }

      // Jira Server/DC: sprint field directly
      if (fields.sprint && typeof fields.sprint === 'object') {
        activeSprint = fields.sprint;
        break;
      }

      // Some instances return sprint as a string like "com.atlassian.greenhopper..."
      if (typeof fields.sprint === 'string' && fields.sprint.includes('name=')) {
        const nameMatch = fields.sprint.match(/name=([^,\]]+)/);
        const endMatch = fields.sprint.match(/endDate=([^,\]]+)/);
        if (nameMatch) {
          activeSprint = {
            name: nameMatch[1],
            endDate: endMatch ? endMatch[1] : null,
          };
          break;
        }
      }
    }

    // Calculate points from all issues
    let pointsCompleted = 0;
    let pointsTotal = 0;
    for (const issue of issues) {
      const pts = this.getStoryPoints(issue);
      pointsTotal += pts;
      const status = issue.fields.status.name.toLowerCase();
      if (status.includes('done') || status.includes('closed') || status.includes('resolved')) {
        pointsCompleted += pts;
      }
    }

    const endDate = activeSprint?.endDate ? new Date(activeSprint.endDate) : null;
    const now = new Date();
    const daysLeft = endDate && !isNaN(endDate.getTime())
      ? Math.max(0, Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))
      : -1;

    return {
      name: activeSprint?.name || 'Current Sprint',
      daysLeft,
      endDate: activeSprint?.endDate || '',
      pointsCompleted,
      pointsTotal,
    };
  }

  async getIssue(issueKey: string): Promise<JiraIssue> {
    return this.request<JiraIssue>(
      'GET',
      `/issue/${issueKey}?fields=summary,status,priority,issuetype,assignee,reporter,description,created,updated,project,labels,comment,subtasks&expand=subtasks`
    );
  }

  async getSubtaskDetails(subtaskKey: string): Promise<{ priority: { name: string }; assignee: { displayName: string; name: string; accountId?: string } | null }> {
    const issue = await this.request<any>('GET', `/issue/${subtaskKey}?fields=priority,assignee`);
    return {
      priority: issue.fields.priority ?? { name: 'Medium' },
      assignee: issue.fields.assignee ?? null,
    };
  }

  async getTransitions(issueKey: string): Promise<JiraTransition[]> {
    const result = await this.request<{ transitions: JiraTransition[] }>(
      'GET',
      `/issue/${issueKey}/transitions`
    );
    return result.transitions;
  }

  async transitionIssue(issueKey: string, transitionId: string): Promise<void> {
    await this.request<void>('POST', `/issue/${issueKey}/transitions`, {
      transition: { id: transitionId },
    });
  }

  async createIssue(request: CreateIssueRequest): Promise<JiraIssue> {
    return this.request<JiraIssue>('POST', '/issue', request);
  }

  async updateIssue(
    issueKey: string,
    fields: Partial<JiraIssue['fields']>
  ): Promise<void> {
    await this.request<void>('PUT', `/issue/${issueKey}`, { fields });
  }

  async addComment(issueKey: string, body: string): Promise<void> {
    await this.request<void>('POST', `/issue/${issueKey}/comment`, { body });
  }

  async getProjects(): Promise<JiraProject[]> {
    return this.request<JiraProject[]>('GET', '/project');
  }

  async getSubtaskIssueType(projectKey: string): Promise<{ id: string; name: string }> {
    const result = await this.request<{ issueTypes: { id: string; name: string; subtask: boolean }[] }>(
      'GET',
      `/project/${projectKey}`
    );
    const subtaskType = result.issueTypes.find((t) => t.subtask);
    if (!subtaskType) {
      throw new Error('No subtask issue type found for this project');
    }
    return { id: subtaskType.id, name: subtaskType.name };
  }

  async deleteIssue(issueKey: string): Promise<void> {
    await this.request<void>('DELETE', `/issue/${issueKey}`);
  }

  getUsername(): string {
    return this.getConfig().username;
  }

  isConfigured(): boolean {
    const { baseUrl, username } = this.getConfig();
    return !!(baseUrl && username);
  }
}
