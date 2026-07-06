export interface JiraIssue {
  key: string;
  id: string;
  fields: {
    [fieldId: string]: unknown;
    summary: string;
    status: {
      name: string;
      id: string;
    };
    priority: {
      name: string;
      iconUrl: string;
    };
    issuetype: {
      name: string;
      iconUrl: string;
    };
    assignee: {
      displayName: string;
      emailAddress: string;
    } | null;
    reporter: {
      displayName: string;
      emailAddress: string;
    };
    description: string | null;
    created: string;
    updated: string;
    project: {
      key: string;
      name: string;
    };
    parent?: {
      key: string;
      fields?: {
        summary?: string;
        status?: { name: string; id?: string };
        issuetype?: { name: string; iconUrl?: string };
      };
    };
    labels: string[];
    story_points?: number;
    customfield_10016?: number;
    customfield_10020?: JiraSprint[];
    subtasks?: JiraSubtask[];
    comment?: {
      comments: JiraComment[];
      total: number;
    };
  };
}

export interface JiraSubtask {
  id: string;
  key: string;
  fields: {
    [fieldId: string]: unknown;
    summary: string;
    status: {
      name: string;
      id: string;
    };
    priority: {
      name: string;
    };
    assignee: {
      displayName: string;
      name?: string;
      emailAddress?: string;
      accountId?: string;
    } | null;
  };
}

export interface JiraSprint {
  id: number;
  name: string;
  state: string;
  startDate?: string;
  endDate?: string;
}

export interface SprintInfo {
  name: string;
  daysLeft: number;
  endDate: string;
  pointsCompleted: number;
  pointsTotal: number;
  issueCount: number;
}

export interface JiraComment {
  id: string;
  author: {
    displayName: string;
  };
  body: string;
  created: string;
}

export interface JiraTransition {
  id: string;
  name: string;
  to: {
    name: string;
    id: string;
  };
}

export interface CreateIssueRequest {
  fields: {
    project: { key: string };
    summary: string;
    description?: string;
    issuetype: { name: string };
    priority?: { name: string };
    labels?: string[];
  };
}

export interface JiraProject {
  key: string;
  name: string;
  id: string;
}
