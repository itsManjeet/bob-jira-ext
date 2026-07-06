import * as vscode from 'vscode';
import {
  JiraIssue,
  JiraTransition,
  CreateIssueRequest,
  JiraProject,
  SprintInfo,
} from '../models/jiraTypes';

type JiraErrorResponse = {
  errorMessages?: string[];
  errors?: Record<string, string>;
};

type JiraField = {
  id: string;
  name: string;
  schema?: {
    type?: string;
    custom?: string;
  };
};

type JiraUser = {
  accountId?: string;
  name?: string;
  emailAddress?: string;
  displayName?: string;
};

export class JiraService {
  private static readonly requestTimeoutMs = 30_000;
  private context: vscode.ExtensionContext;
  private jiraFieldsPromise?: Promise<JiraField[]>;
  private resolvedStoryPointsField?: string;
  private resolvedSprintField?: string;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  static normalizeBaseUrl(value: string): string {
    return value.trim().replace(/\/+$/, '');
  }

  static validateBaseUrl(value: string): string | undefined {
    if (!value) {
      return 'Jira base URL is required.';
    }

    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return 'Jira base URL must start with http:// or https://.';
      }
      if (url.pathname !== '/' && url.pathname !== '') {
        return 'Use the Jira site root, for example https://your-domain.atlassian.net, without /rest/api/...';
      }
    } catch {
      return 'Jira base URL is not a valid URL.';
    }

    return undefined;
  }

  clearFieldCache(): void {
    this.jiraFieldsPromise = undefined;
    this.resolvedStoryPointsField = undefined;
    this.resolvedSprintField = undefined;
  }

  private getConfig() {
    const config = vscode.workspace.getConfiguration('jira');
    return {
      baseUrl: JiraService.normalizeBaseUrl(config.get<string>('baseUrl', '')),
      username: config.get<string>('username', '').trim(),
      project: config.get<string>('project', '').trim(),
      storyPointsField: config.get<string>('storyPointsField', '').trim(),
    };
  }

  private static isCustomFieldId(value: string): boolean {
    return /^customfield_\d+$/.test(value.trim());
  }

  private static normalizeFieldName(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  private static isNumberField(field: JiraField): boolean {
    const type = field.schema?.type?.toLowerCase() ?? '';
    const custom = field.schema?.custom?.toLowerCase() ?? '';
    return type === 'number' || custom.includes('float') || custom.includes('number');
  }

  private getStoryPointsCandidates(): string[] {
    const configuredField = this.getConfig().storyPointsField;
    return Array.from(new Set([
      this.resolvedStoryPointsField,
      JiraService.isCustomFieldId(configuredField) ? configuredField : undefined,
      'customfield_10016',
      'customfield_10028',
      'customfield_10024',
    ].filter((field): field is string => !!field)));
  }

  private coerceStoryPoints(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }

  getStoryPoints(issue: JiraIssue): number {
    const fields = issue.fields as Record<string, unknown>;
    for (const field of this.getStoryPointsCandidates()) {
      if (Object.prototype.hasOwnProperty.call(fields, field)) {
        return this.coerceStoryPoints(fields[field]);
      }
    }
    return 0;
  }

  private async getStoryPointsFieldForIssue(issue?: JiraIssue): Promise<string> {
    const issueFields = issue?.fields as Record<string, unknown> | undefined;

    if (issueFields) {
      const existingField = this.getStoryPointsCandidates().find((field) =>
        Object.prototype.hasOwnProperty.call(issueFields, field)
      );
      if (existingField) {
        return existingField;
      }
    }

    const resolvedField = await this.resolveStoryPointsField();
    if (resolvedField) {
      return resolvedField;
    }

    const { storyPointsField } = this.getConfig();
    const configuredHint = storyPointsField
      ? ` The configured value "${storyPointsField}" did not match a Jira field.`
      : '';
    throw new Error(
      `Could not find the Jira Story Points field.${configuredHint} Set jira.storyPointsField to your Jira field id, for example customfield_10016.`
    );
  }

  async setStoryPoints(issue: JiraIssue, points: number): Promise<void> {
    const field = await this.getStoryPointsFieldForIssue(issue);
    const safePoints = Math.max(0, points);
    await this.updateIssue(issue.key, { [field]: safePoints } as any);
  }

  private async getJiraFields(): Promise<JiraField[]> {
    if (!this.jiraFieldsPromise) {
      this.jiraFieldsPromise = this.request<JiraField[]>('GET', '/field').catch((error) => {
        console.warn('Unable to load Jira fields for story point detection.', error);
        return [];
      });
    }
    return this.jiraFieldsPromise;
  }

  private async resolveStoryPointsField(): Promise<string | undefined> {
    if (this.resolvedStoryPointsField) {
      return this.resolvedStoryPointsField;
    }

    const { storyPointsField } = this.getConfig();
    if (JiraService.isCustomFieldId(storyPointsField)) {
      this.resolvedStoryPointsField = storyPointsField;
      return this.resolvedStoryPointsField;
    }

    const fields = await this.getJiraFields();
    const normalizedConfigured = JiraService.normalizeFieldName(storyPointsField);
    if (normalizedConfigured) {
      const configuredMatch = fields.find((field) =>
        JiraService.normalizeFieldName(field.name) === normalizedConfigured ||
        JiraService.normalizeFieldName(field.id) === normalizedConfigured
      );
      if (configuredMatch) {
        this.resolvedStoryPointsField = configuredMatch.id;
        return configuredMatch.id;
      }
    }

    const exactStoryPointNames = new Set([
      'storypoints',
      'storypoint',
      'storypointestimate',
      'storypointsestimate',
      'storypointestimates',
      'estimatepoints',
    ]);

    const exactMatch = fields.find((field) =>
      exactStoryPointNames.has(JiraService.normalizeFieldName(field.name)) &&
      JiraService.isNumberField(field)
    );
    if (exactMatch) {
      this.resolvedStoryPointsField = exactMatch.id;
      return exactMatch.id;
    }

    const heuristicMatch = fields.find((field) => {
      const normalizedName = JiraService.normalizeFieldName(field.name);
      return normalizedName.includes('story') &&
        normalizedName.includes('point') &&
        JiraService.isNumberField(field);
    });
    if (heuristicMatch) {
      this.resolvedStoryPointsField = heuristicMatch.id;
      return heuristicMatch.id;
    }

    return undefined;
  }

  private async resolveSprintField(): Promise<string | undefined> {
    if (this.resolvedSprintField) {
      return this.resolvedSprintField;
    }

    const fields = await this.getJiraFields();
    const sprintField = fields.find((field) => {
      const normalizedName = JiraService.normalizeFieldName(field.name);
      const custom = field.schema?.custom?.toLowerCase() ?? '';
      return normalizedName === 'sprint' || custom.includes('sprint');
    });

    this.resolvedSprintField = sprintField?.id;
    return this.resolvedSprintField;
  }

  private async getIssueFields(extraFields: string[] = []): Promise<string> {
    const [storyPointsField, sprintField] = await Promise.all([
      this.resolveStoryPointsField(),
      this.resolveSprintField(),
    ]);
    const fields = [
      'summary',
      'status',
      'priority',
      'issuetype',
      'assignee',
      'reporter',
      'description',
      'created',
      'updated',
      'project',
      'parent',
      'labels',
      storyPointsField,
      ...this.getStoryPointsCandidates(),
      sprintField,
      'customfield_10020',
      'sprint',
      ...extraFields,
    ];

    return Array.from(
      new Set(
        fields
          .filter((field): field is string => !!field)
          .flatMap((field) => field.split(','))
          .map((field) => field.trim())
          .filter(Boolean)
      )
    ).join(',');
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
        await this.context.secrets.store('jira.apiToken', token.trim());
      }
    }
    return token;
  }

  private buildApiUrl(path: string): string {
    const { baseUrl } = this.getConfig();
    const validationError = JiraService.validateBaseUrl(baseUrl);
    if (validationError) {
      throw new Error(validationError);
    }

    return new URL(`/rest/api/2${path}`, `${baseUrl}/`).toString();
  }

  private getErrorMessage(status: number, responseBody: string): string {
    const message = `Jira API error (${status})`;

    if (!responseBody) {
      return message;
    }

    try {
      const errorJson = JSON.parse(responseBody) as JiraErrorResponse;
      if (errorJson.errorMessages?.length) {
        return errorJson.errorMessages.join(', ');
      }
      if (errorJson.errors && Object.keys(errorJson.errors).length > 0) {
        return Object.values(errorJson.errors).join(', ');
      }
    } catch {
      // Fall through to the plain-text body below.
    }

    return responseBody || message;
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
    const url = this.buildApiUrl(path);
    const headers: Record<string, string> = {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), JiraService.requestTimeoutMs);
    const options: RequestInit = { method, headers, signal: controller.signal };
    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(url, options);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Jira request timed out after 30 seconds.');
      }
      const message = error instanceof Error ? error.message : 'Unknown network error';
      throw new Error(`Failed to reach Jira: ${message}`);
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();

    if (!response.ok) {
      throw new Error(this.getErrorMessage(response.status, text));
    }

    if (!text) {
      return {} as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  private async searchIssues(jql: string, maxResults = 50): Promise<JiraIssue[]> {
    const params = new URLSearchParams({
      jql,
      maxResults: String(maxResults),
      fields: await this.getIssueFields(),
    });
    const result = await this.request<{ issues: JiraIssue[] }>('GET', `/search?${params.toString()}`);
    return result.issues ?? [];
  }

  async getMyIssues(): Promise<JiraIssue[]> {
    return this.searchIssues('assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC');
  }

  private async getAssignedOpenSprintIssues(): Promise<JiraIssue[]> {
    try {
      return await this.searchIssues('assignee = currentUser() AND sprint in openSprints() ORDER BY updated DESC', 100);
    } catch (error) {
      console.warn('Unable to query open sprint issues, falling back to unresolved issues.', error);
      return [];
    }
  }

  async getSprintData(): Promise<{ issues: JiraIssue[]; sprint: SprintInfo }> {
    const [issues, sprintIssues] = await Promise.all([
      this.getMyIssues(),
      this.getAssignedOpenSprintIssues(),
    ]);
    const sprint = this.extractSprintInfo(sprintIssues.length > 0 ? sprintIssues : issues);
    return { issues, sprint };
  }

  private extractSprintInfo(issues: JiraIssue[]): SprintInfo {
    // Try to find active sprint from issue fields.
    let activeSprint: any = null;
    for (const issue of issues) {
      const fields = issue.fields as any;

      const sprintField = this.resolvedSprintField ? fields[this.resolvedSprintField] : undefined;
      if (Array.isArray(sprintField) && sprintField.length > 0) {
        activeSprint = sprintField.find((s: any) => s.state === 'active') || sprintField[sprintField.length - 1];
        if (activeSprint) { break; }
      }
      if (sprintField && typeof sprintField === 'object' && !Array.isArray(sprintField)) {
        activeSprint = sprintField;
        break;
      }
      if (typeof sprintField === 'string' && sprintField.includes('name=')) {
        const nameMatch = sprintField.match(/name=([^,\]]+)/);
        const endMatch = sprintField.match(/endDate=([^,\]]+)/);
        if (nameMatch) {
          activeSprint = {
            name: nameMatch[1],
            endDate: endMatch ? endMatch[1] : null,
          };
          break;
        }
      }

      // Jira Cloud commonly returns Sprint as customfield_10020.
      const sprints = fields.customfield_10020;
      if (Array.isArray(sprints) && sprints.length > 0) {
        activeSprint = sprints.find((s: any) => s.state === 'active') || sprints[sprints.length - 1];
        if (activeSprint) { break; }
      }

      // Jira Server/DC: sprint field directly.
      if (fields.sprint && typeof fields.sprint === 'object') {
        activeSprint = fields.sprint;
        break;
      }

      // Some instances return sprint as a string like "com.atlassian.greenhopper...".
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

    // Calculate points from all issues.
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
      issueCount: issues.length,
    };
  }

  async getIssue(issueKey: string): Promise<JiraIssue> {
    const params = new URLSearchParams({
      fields: await this.getIssueFields(['comment', 'subtasks']),
    });
    return this.request<JiraIssue>('GET', `/issue/${encodeURIComponent(issueKey)}?${params.toString()}`);
  }

  async getSubtaskDetails(subtaskKey: string): Promise<{ priority: { name: string }; assignee: { displayName: string; name: string; accountId?: string } | null }> {
    const params = new URLSearchParams({ fields: 'priority,assignee' });
    const issue = await this.request<any>('GET', `/issue/${encodeURIComponent(subtaskKey)}?${params.toString()}`);
    return {
      priority: issue.fields.priority ?? { name: 'Medium' },
      assignee: issue.fields.assignee ?? null,
    };
  }

  async getTransitions(issueKey: string): Promise<JiraTransition[]> {
    const result = await this.request<{ transitions: JiraTransition[] }>(
      'GET',
      `/issue/${encodeURIComponent(issueKey)}/transitions`
    );
    return result.transitions;
  }

  async transitionIssue(issueKey: string, transitionId: string): Promise<void> {
    await this.request<void>('POST', `/issue/${encodeURIComponent(issueKey)}/transitions`, {
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
    await this.request<void>('PUT', `/issue/${encodeURIComponent(issueKey)}`, { fields });
  }

  async addComment(issueKey: string, body: string): Promise<void> {
    await this.request<void>('POST', `/issue/${encodeURIComponent(issueKey)}/comment`, { body });
  }

  async getCurrentUser(): Promise<JiraUser> {
    return this.request<JiraUser>('GET', '/myself');
  }

  async assignIssueToCurrentUser(issueKey: string): Promise<void> {
    const currentUser = await this.getCurrentUser();

    if (currentUser.accountId) {
      try {
        await this.request<void>(
          'PUT',
          `/issue/${encodeURIComponent(issueKey)}/assignee`,
          { accountId: currentUser.accountId }
        );
        return;
      } catch (error) {
        // Jira Server/Data Center does not support accountId. Fall back to name below.
        if (!currentUser.name) {
          throw error;
        }
      }
    }

    const name = currentUser.name || this.getUsername();
    await this.request<void>(
      'PUT',
      `/issue/${encodeURIComponent(issueKey)}/assignee`,
      { name }
    );
  }

  async getProjects(): Promise<JiraProject[]> {
    return this.request<JiraProject[]>('GET', '/project');
  }

  async getSubtaskIssueType(projectKey: string): Promise<{ id: string; name: string }> {
    const result = await this.request<{ issueTypes: { id: string; name: string; subtask: boolean }[] }>(
      'GET',
      `/project/${encodeURIComponent(projectKey)}`
    );
    const subtaskType = result.issueTypes.find((t) => t.subtask);
    if (!subtaskType) {
      throw new Error('No subtask issue type found for this project');
    }
    return { id: subtaskType.id, name: subtaskType.name };
  }

  async deleteIssue(issueKey: string): Promise<void> {
    await this.request<void>('DELETE', `/issue/${encodeURIComponent(issueKey)}`);
  }

  getUsername(): string {
    return this.getConfig().username;
  }

  isConfigured(): boolean {
    const { baseUrl, username } = this.getConfig();
    return !!(baseUrl && username);
  }
}
