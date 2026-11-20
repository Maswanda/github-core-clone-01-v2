// graphql.ts — GitHub GraphQL v4 for the forge: a small parser and executor for
// the documents gh and github-mcp-server actually send (viewer, repository,
// issues, pull requests, the __type probes, node(id:), and the five mutations).
//
// No GraphQL library exists in the stdlib, so this file parses the subset the
// suite uses: operations with variables, aliases, inline input objects and
// lists, inline enums, and inline fragments. Unknown fields are HTTP 200 with
// an errors array naming the field, exactly as GitHub answers them.

import {
  parseGlobalId,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import {
  addCommentToIssue,
  authorized,
  commentNodeId,
  createIssueInRepo,
  createPullInRepo,
  diffTrees,
  issueNodeId,
  mergePullInRepo,
  mergeableOf,
  parseJsonBody,
  pullNodeId,
  repoNodeId,
  resolveRepoOr404,
  ApiError,
} from './rest.ts';

// -------------------------------------------------------------------------------------------
// A small GraphQL parser (the subset the suite's documents use)
// -------------------------------------------------------------------------------------------

type Value =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface Selection {
  alias: string | null;
  name: string;
  args: Record<string, Value>;
  selections: Selection[];
  fragment: string | null;
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: Selection[];
}

interface Token {
  kind: 'name' | 'string' | 'number' | 'punct' | 'variable';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():[]!=@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let out = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          i += 2;
          continue;
        }
        out += source[i] as string;
        i += 1;
      }
      if (i >= source.length) throw new Error('unterminated string');
      i += 1;
      tokens.push({ kind: 'string', value: out });
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'variable', value: source.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(source[i + 1] ?? ''))) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      const text = source.slice(i, j);
      tokens.push({ kind: 'number', value: text });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.value}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek() !== undefined) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): Operation {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '{') {
      return { kind: 'query', name: null, selections: this.parseSelectionSet() };
    }
    const kind = this.expectName();
    if (kind !== 'query' && kind !== 'mutation' && kind !== 'subscription') {
      throw new Error(`unsupported operation ${kind}`);
    }
    let name: string | null = null;
    if (this.peek()?.kind === 'name') name = this.next().value;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.skipVariableDefinitions();
    const selections = this.parseSelectionSet();
    return { kind: kind as 'query' | 'mutation', name, selections };
  }

  /** Skip ($name: Type, ...) — only the names matter, and values come from `variables`. */
  private skipVariableDefinitions(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && (token.value === '(' || token.value === '[')) depth += 1;
      else if (token.kind === 'punct' && (token.value === ')' || token.value === ']')) depth -= 1;
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '...') {
      this.next();
      let fragment: string | null = null;
      if (this.peek()?.kind === 'name' && this.peek()?.value === 'on') {
        this.next();
        fragment = this.expectName();
      } else if (this.peek()?.kind === 'name') {
        // A named fragment spread: the suite never sends one; treat it as an error-free no-op.
        this.next();
        return { alias: null, name: '', args: {}, selections: [], fragment: '__spread__' };
      }
      const selections = this.parseSelectionSet();
      return { alias: null, name: '', args: {}, selections, fragment };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    let args: Record<string, Value> = {};
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      args = this.parseArguments();
    }
    let selections: Selection[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { alias, name, args, selections, fragment: null };
  }

  private parseArguments(): Record<string, Value> {
    this.expectPunct('(');
    const args: Record<string, Value> = {};
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') {
      return token.value.includes('.') || token.value.includes('e') || token.value.includes('E')
        ? { kind: 'float', value: Number.parseFloat(token.value) }
        : { kind: 'int', value: Number.parseInt(token.value, 10) };
    }
    if (token.kind === 'variable') return { kind: 'variable', name: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

/** Resolve a parsed value against the request's variables. */
function evalValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'variable':
      return variables[value.name] ?? null;
    case 'list':
      return value.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

// -------------------------------------------------------------------------------------------
// The schema: which fields each type holds (validation) and what introspection reports
// -------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url',
  ],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'labels', 'comments'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  PullRequest: [
    'id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files',
    'title', 'body', 'url', 'headRef', 'baseRef',
  ],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'filename', 'additions', 'deletions', 'changes'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'author'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

// A runtime value: a tagged object the resolver understands, or a scalar.
type Runtime =
  | { __typename: 'User'; login: string }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'IssueConnection'; repo: Repo; issues: Issue[]; hasNextPage: boolean; endCursor: string | null }
  | { __typename: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'PullRequestConnection'; repo: Repo; pulls: Pull[] }
  | { __typename: 'PullRequestChangedFile'; path: string }
  | { __typename: 'PullRequestChangedFileConnection'; files: Array<{ path: string }> }
  | { __typename: 'CreateIssuePayload'; repo: Repo; issue: Issue }
  | { __typename: 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { __typename: 'CreatePullRequestPayload'; repo: Repo; pull: Pull }
  | { __typename: 'MergePullRequestPayload'; repo: Repo; pull: Pull }
  | { __typename: 'AddCommentPayload'; repo: Repo; issue: Issue; commentId: number; body: string }
  | { __typename: 'IssueCommentEdge'; repo: Repo; issue: Issue; commentId: number; body: string }
  | { __typename: 'IssueComment'; repo: Repo; issue: Issue; commentId: number; body: string }
  | { __typename: '__Type'; name: string }
  | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function argValue(selection: Selection, name: string, ctx: Ctx): unknown {
  const raw = selection.args[name];
  return raw === undefined ? undefined : evalValue(raw, ctx.variables);
}

function argString(selection: Selection, name: string, ctx: Ctx): string | null {
  const value = argValue(selection, name, ctx);
  return typeof value === 'string' ? value : null;
}

function argInt(selection: Selection, name: string, ctx: Ctx): number | null {
  const value = argValue(selection, name, ctx);
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/** Resolve one object's selection set into a JSON object (nulls where a field failed). */
function resolveSelections(typeName: string, value: Runtime, selections: Selection[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fields = TYPE_FIELDS[typeName] ?? [];
  for (const selection of selections) {
    if (selection.fragment !== null) {
      if (selection.fragment === '__spread__') continue;
      if (value !== null && selection.fragment !== value.__typename) continue;
      const nested = resolveSelections(typeName, value, selection.selections, ctx);
      Object.assign(out, nested);
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (!fields.includes(selection.name)) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
      out[key] = null;
      continue;
    }
    out[key] = resolveField(typeName, value, selection, ctx);
  }
  return out;
}

/** Resolve one field of one object. */
function resolveField(typeName: string, value: Runtime, selection: Selection, ctx: Ctx): unknown {
  const store = ctx.store;
  const name = selection.name;
  if (value === null) return null;

  if (typeName === 'User' && value.__typename === 'User') {
    if (name === 'login') return value.login;
    if (name === 'id') return value.login;
  }

  if (typeName === 'Repository' && value.__typename === 'Repository') {
    const repo = value.repo;
    switch (name) {
      case 'id':
        return repoNodeId(store, repo);
      case 'databaseId':
        return repo.databaseId;
      case 'name':
        return repo.name;
      case 'nameWithOwner': {
        const owner = repo.owner !== '' ? repo.owner : (store.viewerLogin ?? '');
        return `${owner}/${repo.name}`;
      }
      case 'owner': {
        const owner = repo.owner !== '' ? repo.owner : (store.viewerLogin ?? '');
        return resolveSelections('User', { __typename: 'User', login: owner }, selection.selections, ctx);
      }
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (tip === undefined) return null;
        return resolveSelections('Ref', { __typename: 'Ref', name: repo.defaultBranch }, selection.selections, ctx);
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'description':
        return repo.description;
      case 'url': {
        const owner = repo.owner !== '' ? repo.owner : (store.viewerLogin ?? '');
        return `/${owner}/${repo.name}`;
      }
      case 'issue': {
        const number = argInt(selection, 'number', ctx);
        if (number === null) return null;
        const issue = repo.issues.get(number);
        if (issue === undefined) return null;
        return resolveSelections('Issue', { __typename: 'Issue', repo, issue }, selection.selections, ctx);
      }
      case 'issues': {
        const connection = issuesConnection(store, repo, selection, ctx);
        return resolveSelections('IssueConnection', connection, selection.selections, ctx);
      }
      case 'pullRequests': {
        const first = argInt(selection, 'first', ctx);
        const pulls = [...repo.pulls.values()].filter((pull) => pull.state === 'open').sort((a, b) => b.number - a.number);
        const limited = first === null ? pulls : pulls.slice(0, first);
        const connection: Runtime = { __typename: 'PullRequestConnection', repo, pulls: limited };
        return resolveSelections('PullRequestConnection', connection, selection.selections, ctx);
      }
      case 'pullRequest': {
        const number = argInt(selection, 'number', ctx);
        if (number === null) return null;
        const pull = repo.pulls.get(number);
        if (pull === undefined) return null;
        return resolveSelections('PullRequest', { __typename: 'PullRequest', repo, pull }, selection.selections, ctx);
      }
    }
  }

  if (typeName === 'Ref' && value.__typename === 'Ref') {
    if (name === 'name') return value.name;
  }

  if (typeName === 'Issue' && value.__typename === 'Issue') {
    const issue = value.issue;
    switch (name) {
      case 'id':
        return issueNodeId(store, value.repo, issue.number);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'body':
        return issue.body;
      case 'url':
        return `#${issue.number}`;
      case 'labels':
        return issue.labels.map((label) => ({ name: label }));
      case 'comments':
        return issue.comments.map((comment) => ({ body: comment.body }));
    }
  }

  if (typeName === 'IssueConnection' && value.__typename === 'IssueConnection') {
    if (name === 'nodes') {
      return value.issues.map((issue) => resolveSelections('Issue', { __typename: 'Issue', repo: value.repo, issue }, selection.selections, ctx));
    }
    if (name === 'pageInfo') {
      return resolveSelections('PageInfo', { __typename: 'PageInfo', hasNextPage: value.hasNextPage, endCursor: value.endCursor }, selection.selections, ctx);
    }
    if (name === 'totalCount') return value.issues.length;
  }

  if (typeName === 'PageInfo' && value.__typename === 'PageInfo') {
    if (name === 'hasNextPage') return value.hasNextPage;
    if (name === 'endCursor') return value.endCursor;
    if (name === 'hasPreviousPage') return false;
    if (name === 'startCursor') return null;
  }

  if (typeName === 'PullRequest' && value.__typename === 'PullRequest') {
    const pull = value.pull;
    switch (name) {
      case 'id':
        return pullNodeId(store, value.repo, pull.number);
      case 'number':
        return pull.number;
      case 'state':
        return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'merged':
        return pull.merged;
      case 'headRefName':
        return pull.head;
      case 'baseRefName':
        return pull.base;
      case 'mergeable':
        return mergeableOf(value.repo, pull);
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'url':
        return `#${pull.number}`;
      case 'headRef':
        return resolveSelections('Ref', { __typename: 'Ref', name: pull.head }, selection.selections, ctx);
      case 'baseRef':
        return resolveSelections('Ref', { __typename: 'Ref', name: pull.base }, selection.selections, ctx);
      case 'files': {
        const first = argInt(selection, 'first', ctx);
        const changes = diffTrees(value.repo, pull.baseSha, pull.headSha);
        const limited = first === null ? changes : changes.slice(0, first);
        const connection: Runtime = {
          __typename: 'PullRequestChangedFileConnection',
          files: limited.map((change) => ({ path: change.filename })),
        };
        return resolveSelections('PullRequestChangedFileConnection', connection, selection.selections, ctx);
      }
    }
  }

  if (typeName === 'PullRequestConnection' && value.__typename === 'PullRequestConnection') {
    if (name === 'nodes') {
      return value.pulls.map((pull) => resolveSelections('PullRequest', { __typename: 'PullRequest', repo: value.repo, pull }, selection.selections, ctx));
    }
    if (name === 'pageInfo') {
      return resolveSelections('PageInfo', { __typename: 'PageInfo', hasNextPage: false, endCursor: null }, selection.selections, ctx);
    }
    if (name === 'totalCount') return value.pulls.length;
  }

  if (typeName === 'PullRequestChangedFile' && value.__typename === 'PullRequestChangedFile') {
    if (name === 'path' || name === 'filename') return value.path;
    if (name === 'additions' || name === 'deletions' || name === 'changes') return 0;
  }

  if (typeName === 'PullRequestChangedFileConnection' && value.__typename === 'PullRequestChangedFileConnection') {
    if (name === 'nodes') {
      return value.files.map((file) => resolveSelections('PullRequestChangedFile', { __typename: 'PullRequestChangedFile', path: file.path }, selection.selections, ctx));
    }
    if (name === 'pageInfo') {
      return resolveSelections('PageInfo', { __typename: 'PageInfo', hasNextPage: false, endCursor: null }, selection.selections, ctx);
    }
    if (name === 'totalCount') return value.files.length;
  }

  if (typeName === '__Type' && value.__typename === '__Type') {
    if (name === 'name') return value.name;
    if (name === 'kind') return value.name === 'SearchType' ? 'ENUM' : 'OBJECT';
    if (name === 'fields') {
      const fields = TYPE_FIELDS[value.name] ?? [];
      return fields.map((field) => ({ name: field }));
    }
    if (name === 'enumValues') {
      if (value.name !== 'SearchType') return [];
      return SEARCH_TYPE_VALUES.map((entry) => ({ name: entry }));
    }
    if (name === 'description') return null;
  }

  if (typeName === 'CreateIssuePayload' && value.__typename === 'CreateIssuePayload') {
    if (name === 'issue') return resolveSelections('Issue', { __typename: 'Issue', repo: value.repo, issue: value.issue }, selection.selections, ctx);
    if (name === 'clientMutationId') return null;
  }
  if (typeName === 'CloseIssuePayload' && value.__typename === 'CloseIssuePayload') {
    if (name === 'issue') return resolveSelections('Issue', { __typename: 'Issue', repo: value.repo, issue: value.issue }, selection.selections, ctx);
    if (name === 'clientMutationId') return null;
  }
  if (typeName === 'CreatePullRequestPayload' && value.__typename === 'CreatePullRequestPayload') {
    if (name === 'pullRequest') return resolveSelections('PullRequest', { __typename: 'PullRequest', repo: value.repo, pull: value.pull }, selection.selections, ctx);
    if (name === 'clientMutationId') return null;
  }
  if (typeName === 'MergePullRequestPayload' && value.__typename === 'MergePullRequestPayload') {
    if (name === 'pullRequest') return resolveSelections('PullRequest', { __typename: 'PullRequest', repo: value.repo, pull: value.pull }, selection.selections, ctx);
    if (name === 'clientMutationId') return null;
  }
  if (typeName === 'AddCommentPayload' && value.__typename === 'AddCommentPayload') {
    if (name === 'commentEdge') {
      return resolveSelections(
        'IssueCommentEdge',
        { __typename: 'IssueCommentEdge', repo: value.repo, issue: value.issue, commentId: value.commentId, body: value.body },
        selection.selections,
        ctx,
      );
    }
    if (name === 'clientMutationId') return null;
  }
  if (typeName === 'IssueCommentEdge' && value.__typename === 'IssueCommentEdge') {
    if (name === 'node') {
      return resolveSelections(
        'IssueComment',
        { __typename: 'IssueComment', repo: value.repo, issue: value.issue, commentId: value.commentId, body: value.body },
        selection.selections,
        ctx,
      );
    }
    if (name === 'cursor') return null;
  }
  if (typeName === 'IssueComment' && value.__typename === 'IssueComment') {
    if (name === 'id') return commentNodeId(store, value.repo, value.issue.number, value.commentId);
    if (name === 'body') return value.body;
    if (name === 'author') {
      const owner = value.repo.owner !== '' ? value.repo.owner : (store.viewerLogin ?? '');
      return resolveSelections('User', { __typename: 'User', login: owner }, selection.selections, ctx);
    }
  }

  return null;
}

/** The issues connection: states filter, CREATED_AT order, and cursor paging. */
function issuesConnection(store: Store, repo: Repo, selection: Selection, ctx: Ctx): Runtime {
  const first = argInt(selection, 'first', ctx);
  const statesRaw = argValue(selection, 'states', ctx);
  const states = Array.isArray(statesRaw) ? (statesRaw as unknown[]).filter((entry): entry is string => typeof entry === 'string') : null;
  const orderBy = argValue(selection, 'orderBy', ctx);
  const after = argString(selection, 'after', ctx);

  let issues = [...repo.issues.values()];
  if (states !== null) {
    const wanted = new Set(states.map((state) => state.toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  let direction = 'desc';
  if (isRecord(orderBy)) {
    const dir = orderBy.direction;
    if (typeof dir === 'string' && dir.toUpperCase() === 'ASC') direction = 'asc';
  }
  issues.sort((a, b) => (direction === 'desc' ? b.seq - a.seq : a.seq - b.seq));

  let start = 0;
  if (after !== null && after !== '') {
    try {
      const decoded = Buffer.from(after, 'base64url').toString('utf8');
      const seq = Number.parseInt(decoded.replace(/^cursor:/, ''), 10);
      if (Number.isInteger(seq)) {
        const at = issues.findIndex((issue) => issue.seq === seq);
        if (at >= 0) start = at + 1;
      }
    } catch {
      // An unreadable cursor starts from the beginning.
    }
  }
  const page = first === null ? issues.slice(start) : issues.slice(start, start + first);
  const hasNextPage = start + page.length < issues.length;
  const endCursor = page.length === 0 ? null : Buffer.from(`cursor:${page[page.length - 1]?.seq ?? 0}`, 'utf8').toString('base64url');
  return { __typename: 'IssueConnection', repo, issues: page, hasNextPage, endCursor };
}

// -------------------------------------------------------------------------------------------
// Root operations and the HTTP entry point
// -------------------------------------------------------------------------------------------

/** Execute one parsed operation against the store. */
function executeOperation(store: Store, operation: Operation, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  const ctx: Ctx = { store, variables, errors: [] };
  const data: Record<string, unknown> = {};
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const rootFields = TYPE_FIELDS[rootType] ?? [];

  for (const selection of operation.selections) {
    if (selection.fragment !== null) continue;
    const key = selection.alias ?? selection.name;
    if (!rootFields.includes(selection.name)) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${rootType}".` });
      data[key] = null;
      continue;
    }
    try {
      data[key] = executeRootField(store, operation.kind, selection, ctx);
    } catch (err) {
      if (err instanceof ApiError) {
        ctx.errors.push({ message: err.message });
        data[key] = null;
        continue;
      }
      throw err;
    }
  }
  return { data, errors: ctx.errors };
}

function executeRootField(store: Store, kind: 'query' | 'mutation', selection: Selection, ctx: Ctx): unknown {
  const name = selection.name;

  if (kind === 'query') {
    if (name === 'viewer') {
      const login = store.viewerLogin ?? '';
      return resolveSelections('User', { __typename: 'User', login }, selection.selections, ctx);
    }
    if (name === 'repository') {
      const owner = argString(selection, 'owner', ctx) ?? '';
      const repoName = argString(selection, 'name', ctx) ?? '';
      let repo: Repo | null = null;
      try {
        repo = resolveRepoOr404(store, owner, repoName);
      } catch {
        repo = null;
      }
      if (repo === null) return null;
      return resolveSelections('Repository', { __typename: 'Repository', repo }, selection.selections, ctx);
    }
    if (name === 'node') {
      const id = argString(selection, 'id', ctx) ?? '';
      const parsed = parseGlobalId(store, id);
      if (parsed === null) return null;
      if (parsed.kind === 'repo') {
        return resolveSelections('Repository', { __typename: 'Repository', repo: parsed.repo }, selection.selections, ctx);
      }
      if (parsed.kind === 'issue') {
        const issue = parsed.repo.issues.get(parsed.number);
        if (issue === undefined) return null;
        return resolveSelections('Issue', { __typename: 'Issue', repo: parsed.repo, issue }, selection.selections, ctx);
      }
      if (parsed.kind === 'pull') {
        const pull = parsed.repo.pulls.get(parsed.number);
        if (pull === undefined) return null;
        return resolveSelections('PullRequest', { __typename: 'PullRequest', repo: parsed.repo, pull }, selection.selections, ctx);
      }
      return null;
    }
    if (name === '__type') {
      const typeName = argString(selection, 'name', ctx) ?? '';
      if (!(typeName in TYPE_FIELDS) && typeName !== 'SearchType') return null;
      return resolveSelections('__Type', { __typename: '__Type', name: typeName }, selection.selections, ctx);
    }
    if (name === '__schema') return null;
  }

  if (kind === 'mutation') {
    const input = argValue(selection, 'input', ctx);
    if (!isRecord(input)) throw new ApiError(400, 'mutation input is required');
    if (name === 'createIssue') {
      const repositoryId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
      const parsed = parseGlobalId(store, repositoryId);
      if (parsed === null || parsed.kind !== 'repo') throw new ApiError(400, 'repositoryId does not name a repository');
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const issue = createIssueInRepo(store, parsed.repo, { title, body });
      return resolveSelections('CreateIssuePayload', { __typename: 'CreateIssuePayload', repo: parsed.repo, issue }, selection.selections, ctx);
    }
    if (name === 'closeIssue') {
      const issueId = typeof input.issueId === 'string' ? input.issueId : '';
      const parsed = parseGlobalId(store, issueId);
      if (parsed === null || parsed.kind !== 'issue') throw new ApiError(400, 'issueId does not name an issue');
      const issue = parsed.repo.issues.get(parsed.number);
      if (issue === undefined) throw new ApiError(404, 'Not Found');
      issue.state = 'closed';
      return resolveSelections('CloseIssuePayload', { __typename: 'CloseIssuePayload', repo: parsed.repo, issue }, selection.selections, ctx);
    }
    if (name === 'createPullRequest') {
      const repositoryId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
      const parsed = parseGlobalId(store, repositoryId);
      if (parsed === null || parsed.kind !== 'repo') throw new ApiError(400, 'repositoryId does not name a repository');
      const title = typeof input.title === 'string' ? input.title : '';
      const baseRefName = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const headRefName = typeof input.headRefName === 'string' ? input.headRefName : '';
      const pull = createPullInRepo(store, parsed.repo, { title, head: headRefName, base: baseRefName });
      return resolveSelections('CreatePullRequestPayload', { __typename: 'CreatePullRequestPayload', repo: parsed.repo, pull }, selection.selections, ctx);
    }
    if (name === 'mergePullRequest') {
      const pullRequestId = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
      const parsed = parseGlobalId(store, pullRequestId);
      if (parsed === null || parsed.kind !== 'pull') throw new ApiError(400, 'pullRequestId does not name a pull request');
      const pull = parsed.repo.pulls.get(parsed.number);
      if (pull === undefined) throw new ApiError(404, 'Not Found');
      mergePullInRepo(store, parsed.repo, pull);
      return resolveSelections('MergePullRequestPayload', { __typename: 'MergePullRequestPayload', repo: parsed.repo, pull }, selection.selections, ctx);
    }
    if (name === 'addComment') {
      const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
      const parsed = parseGlobalId(store, subjectId);
      if (parsed === null || parsed.kind !== 'issue') throw new ApiError(400, 'subjectId does not name an issue');
      const issue = parsed.repo.issues.get(parsed.number);
      if (issue === undefined) throw new ApiError(404, 'Not Found');
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = addCommentToIssue(parsed.repo, issue, body);
      return resolveSelections(
        'AddCommentPayload',
        { __typename: 'AddCommentPayload', repo: parsed.repo, issue, commentId: comment.id, body },
        selection.selections,
        ctx,
      );
    }
  }
  return null;
}

export interface GraphQLReply {
  status: number;
  body: unknown;
}

/** The one entry point app.ts calls for POST /api/graphql. */
export function handleGraphQL(
  store: Store,
  method: string,
  headers: Record<string, string | string[] | undefined>,
  rawBody: Buffer,
): GraphQLReply {
  if (method !== 'POST') {
    return { status: 405, body: { errors: [{ message: 'method not allowed' }] } };
  }
  if (!authorized(headers)) {
    return { status: 401, body: { errors: [{ message: 'Requires authentication' }] } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    return { status: 400, body: { errors: [{ message: 'Problems parsing JSON' }] } };
  }
  const operations: Array<Record<string, unknown>> = Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [parsed as Record<string, unknown>];
  const results = operations.map((operation) => {
    const query = typeof operation.query === 'string' ? operation.query : '';
    const variables = isRecord(operation.variables) ? (operation.variables as Record<string, unknown>) : {};
    const operationName = typeof operation.operationName === 'string' ? operation.operationName : null;
    let document: Operation[];
    try {
      document = new Parser(query).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'could not parse the query' }] };
    }
    let chosen = document[0];
    if (operationName !== null) {
      const named = document.find((entry) => entry.name === operationName);
      if (named !== undefined) chosen = named;
    }
    if (chosen === undefined) {
      return { data: null, errors: [{ message: 'no operation in the document' }] };
    }
    try {
      const { data, errors } = executeOperation(store, chosen, variables);
      return errors.length === 0 ? { data } : { data, errors };
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'internal error' }] };
    }
  });
  return { status: 200, body: Array.isArray(parsed) ? results : results[0] };
}
