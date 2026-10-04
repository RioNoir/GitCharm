import * as vscode from 'vscode';
import { HttpJsonError } from './httpJson';
import type { PullRequestUser } from './types';

// The REST plumbing shared by the Azure DevOps pull request and work item providers. Both Azure DevOps Services
// and Azure DevOps Server 2020+ serve the same API under an organization / project collection URL (`apiBase`).

/** The oldest API version Azure DevOps Server 2020 serves — every call pins it so Services and Server behave alike. */
export const API_VERSION = '6.0';
/** Endpoints that never left preview in 6.0 (pull request labels and statuses, policy evaluations, tags). */
export const API_VERSION_PREVIEW = '6.0-preview.1';

const MEMBERS_TTL_MS = 5 * 60 * 1000;
const MAX_TEAMS = 25;

export interface RawIdentityRef {
  id: string;
  displayName: string;
  uniqueName?: string;
  imageUrl?: string;
  isContainer?: boolean;
  _links?: { avatar?: { href?: string } };
}

export interface AzureDevOpsUser {
  id: string;
  displayName: string;
  uniqueName?: string;
}

/** Mentions are `@<identity id>` in Azure DevOps markdown. The webview's mention support reads `@{id}` (an id
 * mention it resolves to a name through the member list), so they're swapped on the way in and back on the way out. */
export function mentionsFromAzure(text: string): string {
  return text.replace(/@<([0-9a-fA-F-]{36})>/g, '@{$1}');
}

export function mentionsToAzure(text: string): string {
  return text.replace(/@\{([0-9a-fA-F-]{36})\}/g, '@<$1>');
}

/** The project of an `owner` (`{organization}/{project}`, or `{collection path}/{project}` on a server). */
export function projectOf(owner: string): string {
  return owner.slice(owner.lastIndexOf('/') + 1);
}

export class AzureDevOpsClient {
  private currentUser: Promise<AzureDevOpsUser | undefined> | undefined;
  private readonly avatars = new Map<string, Promise<string | undefined>>();
  private readonly members = new Map<string, { users: Promise<PullRequestUser[]>; fetchedAt: number }>();
  /** Every identity mapped to a user so far, by id — work item fields take a unique name, not an id. */
  private readonly identities = new Map<string, RawIdentityRef>();

  constructor(
    readonly apiBase: string,
    /** The `Authorization` header value: Basic for a personal access token, Bearer for a Microsoft account. */
    private readonly getAuthorization: () => Promise<string | undefined>,
  ) {}

  async hasCredentials(): Promise<boolean> {
    return (await this.getAuthorization()) !== undefined;
  }

  /** `{apiBase}/{project}` — the root of project-scoped endpoints, and of the web UI's project pages. */
  projectUrl(owner: string): string {
    return `${this.apiBase}/${encodeURIComponent(projectOf(owner))}`;
  }

  /** Same as `projectUrl` plus `/_apis/git/repositories/{repo}`. */
  repoApiUrl(owner: string, repo: string): string {
    return `${this.projectUrl(owner)}/_apis/git/repositories/${encodeURIComponent(repo)}`;
  }

  /**
   * A JSON request. `url` is absolute; `api-version` is appended unless already present (pass `apiVersion: null` to
   * leave it out). The redirect-suppression header makes a bad or expired token answer 401 instead of the HTML
   * sign-in page (HTTP 203) Azure DevOps otherwise serves.
   */
  async request<T>(url: string, init: RequestInit & { apiVersion?: string | null; contentType?: string } = {}): Promise<{ data: T; headers: Headers }> {
    const { apiVersion = API_VERSION, contentType, ...rest } = init;
    const target = new URL(url);
    if (apiVersion && !target.searchParams.has('api-version')) target.searchParams.set('api-version', apiVersion);
    const authorization = await this.getAuthorization();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-TFS-FedAuthRedirect': 'Suppress',
      ...(authorization ? { Authorization: authorization } : {}),
      ...(rest.body !== undefined ? { 'Content-Type': contentType ?? 'application/json' } : {}),
      ...(rest.headers as Record<string, string> | undefined),
    };
    const res = await fetch(target.toString(), { ...rest, headers });
    const bodyText = await res.text().catch(() => '');
    const isJson = (res.headers.get('content-type') ?? '').includes('json');
    if (!res.ok || (res.status === 203 && !isJson)) {
      let parsedBody: unknown;
      try { parsedBody = bodyText && isJson ? JSON.parse(bodyText) : undefined; } catch { parsedBody = undefined; }
      if (res.status === 203 || res.status === 401) {
        throw new HttpJsonError(401, vscode.l10n.t('Azure DevOps rejected the credentials (HTTP {0}). The token may be expired or missing a scope.', res.status), parsedBody);
      }
      throw new HttpJsonError(res.status, `HTTP ${res.status} ${res.statusText}${bodyText && isJson ? `: ${bodyText}` : ''}`, parsedBody);
    }
    const data = (bodyText && isJson ? JSON.parse(bodyText) : undefined) as T;
    return { data, headers: res.headers };
  }

  /** The authenticated user — `connectionData` is served by Services and Server alike, at the collection level. */
  getCurrentUser(): Promise<AzureDevOpsUser | undefined> {
    this.currentUser ??= this.request<{ authenticatedUser?: { id: string; providerDisplayName?: string; customDisplayName?: string; properties?: { Account?: { $value?: string } } } }>(
      `${this.apiBase}/_apis/connectionData`, { apiVersion: null },
    ).then(({ data }) => {
      const u = data.authenticatedUser;
      if (!u?.id || u.id === '00000000-0000-0000-0000-000000000000') return undefined;
      return { id: u.id, displayName: u.customDisplayName || u.providerDisplayName || u.id, uniqueName: u.properties?.Account?.$value };
    }).catch(() => {
      this.currentUser = undefined; // a transient failure shouldn't stick for the provider's lifetime
      return undefined;
    });
    return this.currentUser;
  }

  /**
   * Avatars need the same credentials as the API, which an `<img>` in a webview can't send — so each is fetched here
   * once and handed over as a data URI. Undefined (the webview then draws initials) when it can't be loaded.
   */
  avatar(identity: RawIdentityRef | null | undefined): Promise<string | undefined> {
    const url = identity?._links?.avatar?.href ?? identity?.imageUrl;
    if (!url) return Promise.resolve(undefined);
    let cached = this.avatars.get(url);
    if (!cached) {
      cached = (async () => {
        try {
          const authorization = await this.getAuthorization();
          const res = await fetch(url, { headers: { 'X-TFS-FedAuthRedirect': 'Suppress', ...(authorization ? { Authorization: authorization } : {}) } });
          const type = res.headers.get('content-type') ?? '';
          if (!res.ok || !type.startsWith('image/')) return undefined;
          return `data:${type.split(';')[0]};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
        } catch {
          return undefined;
        }
      })();
      this.avatars.set(url, cached);
    }
    return cached;
  }

  async toUser(identity: RawIdentityRef): Promise<PullRequestUser> {
    this.identities.set(identity.id, identity);
    return { id: identity.id, username: identity.displayName, avatarUrl: await this.avatar(identity), mention: `@{${identity.id}}` };
  }

  /** An identity seen in an earlier response (a member list, a work item field…). */
  getIdentity(id: string): RawIdentityRef | undefined {
    return this.identities.get(id);
  }

  /**
   * People of a project, for reviewer/assignee pickers and mentions: the members of its teams (Azure DevOps has no
   * single "project members" endpoint). Groups are left out. Cached for a few minutes per project.
   */
  listProjectMembers(owner: string): Promise<PullRequestUser[]> {
    const project = projectOf(owner);
    const cached = this.members.get(project);
    if (cached && Date.now() - cached.fetchedAt < MEMBERS_TTL_MS) return cached.users;
    const users = (async () => {
      const projectId = encodeURIComponent(project);
      const { data: teams } = await this.request<{ value: { id: string }[] }>(`${this.apiBase}/_apis/projects/${projectId}/teams?$top=${MAX_TEAMS}`);
      const memberLists = await Promise.all(teams.value.map(team =>
        this.request<{ value: { identity: RawIdentityRef }[] }>(`${this.apiBase}/_apis/projects/${projectId}/teams/${team.id}/members?$top=1000`)
          .then(({ data }) => data.value.map(m => m.identity))
          .catch(() => [] as RawIdentityRef[]),
      ));
      const byId = new Map<string, RawIdentityRef>();
      for (const identity of memberLists.flat()) if (!identity.isContainer && !byId.has(identity.id)) byId.set(identity.id, identity);
      const result = await Promise.all([...byId.values()].map(i => this.toUser(i)));
      return result.sort((a, b) => a.username.localeCompare(b.username));
    })();
    users.catch(() => this.members.delete(project));
    this.members.set(project, { users, fetchedAt: Date.now() });
    return users;
  }
}

/** The `Authorization` header for a personal access token — Basic auth with an empty user name. */
export function patAuthorization(token: string): string {
  return `Basic ${Buffer.from(`:${token}`).toString('base64')}`;
}
