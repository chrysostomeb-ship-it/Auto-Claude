/**
 * Web API - Real implementation for browser mode
 *
 * Replaces Electron IPC with HTTP/WebSocket calls to the web server.
 * This provides the same interface as electronAPI.
 */

import type { ElectronAPI, Project, Task, IPCResult } from '../../shared/types';

const API_BASE = '/api';

// Store current project ID for API calls that need it
let currentProjectId: string | null = null;

export function setCurrentProjectId(projectId: string | null): void {
  currentProjectId = projectId;
}

export function getCurrentProjectId(): string | null {
  return currentProjectId;
}

// WebSocket connection for real-time events
let ws: WebSocket | null = null;
const eventListeners = new Map<string, Set<(...args: unknown[]) => void>>();

function getWebSocket(): WebSocket {
  if (!ws || ws.readyState === WebSocket.CLOSED) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onmessage = (event) => {
      try {
        const { event: eventName, data } = JSON.parse(event.data);
        const listeners = eventListeners.get(eventName);
        if (listeners) {
          listeners.forEach((cb) => cb(data));
        }
      } catch (e) {
        console.error('[WebAPI] Failed to parse WebSocket message:', e);
      }
    };

    ws.onclose = () => {
      console.log('[WebAPI] WebSocket closed, reconnecting in 2s...');
      setTimeout(() => getWebSocket(), 2000);
    };
  }
  return ws;
}

// Initialize WebSocket
if (typeof window !== 'undefined') {
  getWebSocket();
}

// Subscribe to events
function on<T>(event: string, callback: (data: T) => void): () => void {
  if (!eventListeners.has(event)) {
    eventListeners.set(event, new Set());
  }
  eventListeners.get(event)!.add(callback as (...args: unknown[]) => void);
  return () => eventListeners.get(event)?.delete(callback as (...args: unknown[]) => void);
}

// HTTP helper
async function request<T>(method: string, path: string, body?: unknown): Promise<IPCResult<T>> {
  try {
    const options: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }
    const response = await fetch(`${API_BASE}${path}`, options);
    return await response.json();
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

/**
 * Web API implementation matching ElectronAPI interface
 */
export const webAPI: ElectronAPI = {
  // ============ Project Operations ============
  getProjects: () => request<Project[]>('GET', '/projects'),
  addProject: (path: string) => request<Project>('POST', '/projects', { path }),
  removeProject: (id: string) => request('DELETE', `/projects/${id}`),
  updateProjectSettings: (id: string, settings: unknown) =>
    request('PATCH', `/projects/${id}/settings`, settings),
  initializeProject: (id: string) => request('POST', `/projects/${id}/initialize`),
  updateProjectAutoBuild: (id: string) => request('POST', `/projects/${id}/update-autobuild`),
  checkProjectVersion: (id: string) => request('GET', `/projects/${id}/version`),

  // ============ Task Operations ============
  getTasks: (projectId: string) => request<Task[]>('GET', `/tasks?projectId=${projectId}`),
  createTask: async (projectId: string, title: string, description: string, metadata?: unknown) => {
    return request('POST', '/tasks', { projectId, title, description, metadata });
  },
  updateTask: (taskId: string, updates: { title?: string; description?: string }) =>
    request('PATCH', `/tasks/${taskId}?projectId=${currentProjectId}`, updates),
  deleteTask: (taskId: string) =>
    request('DELETE', `/tasks/${taskId}?projectId=${currentProjectId}`),
  startTask: (taskId: string, options?: unknown) => {
    console.log('[WebAPI] startTask called:', { taskId, currentProjectId, options });
    if (!currentProjectId) {
      console.error('[WebAPI] ERROR: currentProjectId is not set! Make sure a project is selected.');
    }
    return request('POST', `/tasks/${taskId}/start`, { projectId: currentProjectId, options });
  },
  stopTask: (taskId: string) =>
    request('POST', `/tasks/${taskId}/stop`),
  reviewTask: (taskId: string) =>
    request('GET', `/tasks/${taskId}/review?projectId=${currentProjectId}`),
  getTaskRunningStatus: (taskId: string) =>
    request('GET', `/tasks/${taskId}/status`),
  checkTaskRunning: (taskId: string) =>
    Promise.resolve({ success: true, data: false }),
  recoverStuckTask: (taskId: string, options?: unknown) => {
    console.log('[WebAPI] recoverStuckTask called with:', { taskId, typeofTaskId: typeof taskId, options, currentProjectId });
    return request('POST', `/tasks/${taskId}/recover`, { projectId: currentProjectId, options });
  },
  // Missing task methods
  submitReview: (taskId: string, approved: boolean, feedback?: string) =>
    request('POST', `/tasks/${taskId}/review`, { projectId: currentProjectId, approved, feedback }),
  updateTaskStatus: (taskId: string, status: string) =>
    request('PATCH', `/tasks/${taskId}/status`, { projectId: currentProjectId, status }),
  archiveTasks: (projectId: string, taskIds: string[], version?: string) =>
    request('POST', '/tasks/archive', { projectId, taskIds, version }),
  unarchiveTasks: (projectId: string, taskIds: string[]) =>
    request('POST', '/tasks/unarchive', { projectId, taskIds }),

  // Task Events - with proper data unpacking to match ElectronAPI callback signatures
  // ElectronAPI: onTaskLog(callback: (taskId: string, log: string) => void)
  onTaskLog: (cb: (taskId: string, log: string) => void) =>
    on('task:log', (data: { taskId: string; log: string }) => cb(data.taskId, data.log)),
  // ElectronAPI: onTaskProgress(callback: (taskId: string, plan: ImplementationPlan) => void)
  onTaskProgress: (cb: (taskId: string, plan: unknown) => void) =>
    on('task:progress', (data: { taskId: string; plan: unknown }) => cb(data.taskId, data.plan)),
  // ElectronAPI: onTaskError(callback: (taskId: string, error: string) => void)
  onTaskError: (cb: (taskId: string, error: string) => void) =>
    on('task:error', (data: { taskId: string; error: string }) => cb(data.taskId, data.error)),
  // ElectronAPI: onTaskStatusChange(callback: (taskId: string, status: TaskStatus) => void)
  onTaskStatusChange: (cb: (taskId: string, status: unknown) => void) =>
    on('task:statusChange', (data: { taskId: string; status: unknown }) => cb(data.taskId, data.status)),
  // ElectronAPI: onTaskExecutionProgress(callback: (taskId: string, progress: ExecutionProgress) => void)
  onTaskExecutionProgress: (cb: (taskId: string, progress: unknown) => void) =>
    on('task:executionProgress', (data: { taskId: string; progress: unknown }) => cb(data.taskId, data.progress)),

  // Task Logs
  getTaskLogs: (projectId: string, specId: string) =>
    request('GET', `/tasks/${specId}/logs?projectId=${projectId}`),
  watchTaskLogs: (_projectId: string, _specId: string) => Promise.resolve({ success: true }),
  unwatchTaskLogs: (_specId: string) => Promise.resolve({ success: true }),
  onTaskLogsChanged: (cb: (specId: string, logs: unknown) => void) =>
    on('task:logsChanged', (data: { specId: string; logs: unknown }) => cb(data.specId, data.logs)),
  onTaskLogsStream: (cb: (specId: string, chunk: unknown) => void) =>
    on('task:logsStream', (data: { specId: string; chunk: unknown }) => cb(data.specId, data.chunk)),

  // ============ Workspace Operations ============
  getWorktreeStatus: (taskId: string) =>
    request('GET', `/tasks/${taskId}/worktree/status?projectId=${currentProjectId}`),
  getWorktreeDiff: (taskId: string) =>
    request('GET', `/tasks/${taskId}/worktree/diff?projectId=${currentProjectId}`),
  mergeWorktree: (taskId: string, _options?: { noCommit?: boolean }) =>
    request('POST', `/tasks/${taskId}/worktree/merge`, { projectId: currentProjectId }),
  getMergePreview: (taskId: string) =>
    request('GET', `/tasks/${taskId}/worktree/merge-preview?projectId=${currentProjectId}`),
  mergeWorktreePreview: (taskId: string) =>
    request('GET', `/tasks/${taskId}/worktree/merge-preview?projectId=${currentProjectId}`),
  discardWorktree: (taskId: string) =>
    request('POST', `/tasks/${taskId}/worktree/discard`, { projectId: currentProjectId }),
  // ElectronAPI: listWorktrees(projectId: string)
  listWorktrees: (projectId: string) =>
    request('GET', `/worktrees?projectId=${projectId}`),
  archiveTask: (taskId: string) =>
    request('POST', `/tasks/${taskId}/archive`, { projectId: currentProjectId }),
  unarchiveTask: (taskId: string) =>
    request('POST', `/tasks/${taskId}/unarchive`, { projectId: currentProjectId }),

  // ============ Terminal Operations ============
  createTerminal: (options: { id: string; cwd?: string; cols?: number; rows?: number; projectPath?: string }) =>
    request('POST', '/terminal', options),
  destroyTerminal: (id: string) => request('DELETE', `/terminal/${id}`),
  writeToTerminal: (id: string, data: string) =>
    request('POST', `/terminal/${id}/input`, { data }),
  sendTerminalInput: (id: string, data: string) =>
    request('POST', `/terminal/${id}/input`, { data }),
  resizeTerminal: (id: string, cols: number, rows: number) =>
    request('POST', `/terminal/${id}/resize`, { cols, rows }),
  invokeClaude: (id: string, task: string) =>
    request('POST', `/terminal/${id}/claude`, { task }),
  invokeClaudeInTerminal: (id: string, _cwd?: string) =>
    request('POST', `/terminal/${id}/claude`, { task: '' }),
  generateTerminalName: (_command: string, _cwd?: string) =>
    Promise.resolve({ success: true, data: 'Terminal' }),

  // Terminal Session Management
  // ElectronAPI: getTerminalSessions(projectPath: string)
  getTerminalSessions: (projectPath: string) =>
    request('GET', `/terminal/sessions?projectPath=${encodeURIComponent(projectPath)}`),
  // ElectronAPI: restoreTerminalSession(session: TerminalSession, cols?: number, rows?: number)
  restoreTerminalSession: (session: unknown, cols?: number, rows?: number) =>
    request('POST', `/terminal/sessions/restore`, { session, cols, rows }),
  // ElectronAPI: clearTerminalSessions(projectPath: string)
  clearTerminalSessions: (projectPath: string) =>
    request('DELETE', `/terminal/sessions?projectPath=${encodeURIComponent(projectPath)}`),
  // ElectronAPI: resumeClaudeInTerminal(id: string, sessionId?: string)
  resumeClaudeInTerminal: (id: string, sessionId?: string) =>
    request('POST', `/terminal/${id}/resume`, { sessionId }),
  // ElectronAPI: getTerminalSessionDates(projectPath?: string)
  getTerminalSessionDates: (projectPath?: string) =>
    request('GET', `/terminal/sessions/dates${projectPath ? `?projectPath=${encodeURIComponent(projectPath)}` : ''}`),
  // ElectronAPI: getTerminalSessionsForDate(date: string, projectPath: string) - NOTE: date first!
  getTerminalSessionsForDate: (date: string, projectPath: string) =>
    request('GET', `/terminal/sessions/date/${date}?projectPath=${encodeURIComponent(projectPath)}`),
  // ElectronAPI: restoreTerminalSessionsFromDate(date: string, projectPath: string, cols?, rows?) - NOTE: date first!
  restoreTerminalSessionsFromDate: (date: string, projectPath: string, cols?: number, rows?: number) =>
    request('POST', `/terminal/sessions/restore-from-date`, { date, projectPath, cols, rows }),
  // ElectronAPI: saveTerminalBuffer(terminalId: string, serialized: string)
  saveTerminalBuffer: (terminalId: string, serialized: string) =>
    request('POST', `/terminal/${terminalId}/buffer`, { buffer: serialized }),

  // Terminal Events - with proper data unpacking to match ElectronAPI callback signatures
  // ElectronAPI: onTerminalOutput(callback: (id: string, data: string) => void)
  onTerminalOutput: (cb: (id: string, data: string) => void) =>
    on('terminal:output', (payload: { id: string; data: string }) => cb(payload.id, payload.data)),
  // ElectronAPI: onTerminalExit(callback: (id: string, exitCode: number) => void)
  onTerminalExit: (cb: (id: string, exitCode: number) => void) =>
    on('terminal:exit', (payload: { id: string; exitCode: number }) => cb(payload.id, payload.exitCode)),
  // ElectronAPI: onTerminalTitleChange(callback: (id: string, title: string) => void)
  onTerminalTitleChange: (cb: (id: string, title: string) => void) =>
    on('terminal:titleChange', (payload: { id: string; title: string }) => cb(payload.id, payload.title)),
  // ElectronAPI: onTerminalClaudeSession(callback: (id: string, sessionId: string) => void)
  onTerminalClaudeSession: (cb: (id: string, sessionId: string) => void) =>
    on('terminal:claudeSession', (payload: { id: string; sessionId: string }) => cb(payload.id, payload.sessionId)),
  // ElectronAPI: onTerminalRateLimit(callback: (info: RateLimitInfo) => void)
  onTerminalRateLimit: (cb: (info: unknown) => void) => on('terminal:rateLimit', cb),
  // ElectronAPI: onTerminalOAuthToken(callback: (info: {...}) => void)
  onTerminalOAuthToken: (cb: (info: unknown) => void) => on('terminal:oauthToken', cb),

  // ============ Claude Profile Management ============
  getClaudeProfiles: () => request('GET', '/agent/profiles'),
  saveClaudeProfile: (profile: unknown) => request('POST', '/agent/profiles', profile),
  deleteClaudeProfile: (id: string) => request('DELETE', `/agent/profiles/${id}`),
  renameClaudeProfile: (id: string, name: string) =>
    request('PATCH', `/agent/profiles/${id}`, { name }),
  // ElectronAPI names
  setActiveClaudeProfile: (id: string) => request('POST', `/agent/profiles/${id}/activate`),
  switchClaudeProfile: (terminalId: string, profileId: string) =>
    request('POST', `/agent/profiles/${profileId}/switch`, { terminalId }),
  initializeClaudeProfile: (profileId: string) =>
    request('POST', `/agent/profiles/${profileId}/initialize`),
  setClaudeProfileToken: (id: string, token: string) =>
    request('POST', `/agent/profiles/${id}/token`, { token }),
  fetchClaudeUsage: (terminalId: string) =>
    request('GET', `/agent/profiles/usage?terminalId=${terminalId}`),
  // Aliases for backwards compatibility
  setActiveProfile: (id: string) => request('POST', `/agent/profiles/${id}/activate`),
  switchProfile: (id: string) => request('POST', `/agent/profiles/${id}/switch`),
  initializeProfiles: () => request('POST', '/agent/profiles/initialize'),
  setProfileToken: (id: string, token: string) =>
    request('POST', `/agent/profiles/${id}/token`, { token }),
  getAutoSwitchSettings: () => request('GET', '/agent/profiles/auto-switch'),
  updateAutoSwitchSettings: (settings: unknown) =>
    request('PUT', '/agent/profiles/auto-switch', settings),
  fetchProfileUsage: (id: string) => request('GET', `/agent/profiles/${id}/usage`),
  getBestAvailableProfile: (excludeId?: string) =>
    request('GET', `/agent/profiles/best${excludeId ? `?exclude=${excludeId}` : ''}`),
  // ElectronAPI: onSDKRateLimit(callback: (info: SDKRateLimitInfo) => void)
  onSDKRateLimit: (cb: (info: unknown) => void) => on('claude:sdkRateLimit', cb),
  // ElectronAPI: retryWithProfile(request: RetryWithProfileRequest)
  retryWithProfile: (retryRequest: unknown) => request('POST', '/agent/retry', retryRequest),
  // ElectronAPI: onUsageUpdated(callback: (usage: ClaudeUsageSnapshot) => void)
  onUsageUpdated: (cb: (usage: unknown) => void) => on('claude:usageUpdated', cb),
  // ElectronAPI: requestUsageUpdate()
  requestUsageUpdate: () => request('GET', '/agent/usage'),
  // ElectronAPI: onProactiveSwapNotification(callback: (...) => void)
  onProactiveSwapNotification: (cb: (notification: unknown) => void) => on('claude:proactiveSwapNotification', cb),

  // ============ Settings ============
  getSettings: () => request('GET', '/settings'),
  saveSettings: (settings: unknown) => request('PUT', '/settings', settings),

  // ============ Dialogs ============
  selectDirectory: async () => {
    // In web mode, we can't use native dialogs
    // Return null to indicate cancellation
    const path = window.prompt('Enter project path:');
    return path || null;
  },
  createProjectFolder: async (_location: string, _name: string, _initGit: boolean) => {
    return { success: false, error: 'Not supported in web mode' };
  },
  getDefaultProjectLocation: async () => null,

  // ============ App Info ============
  getAppVersion: async () => {
    const result = await request<{ version: string }>('GET', '/version');
    return result.data?.version || 'unknown';
  },
  openExternal: async (url: string) => {
    window.open(url, '_blank');
  },

  // ============ Roadmap ============
  getRoadmap: (projectId: string) => request('GET', `/roadmap?projectId=${projectId}`),
  getRoadmapStatus: (projectId: string) => request('GET', `/roadmap/status?projectId=${projectId}`),
  saveRoadmap: (projectId: string, roadmap: unknown) =>
    request('PUT', `/roadmap?projectId=${projectId}`, roadmap),
  generateRoadmap: (projectId: string, enableCompetitorAnalysis?: boolean, refreshCompetitorAnalysis?: boolean) =>
    request('POST', `/roadmap/generate`, { projectId, enableCompetitorAnalysis, refreshCompetitorAnalysis }),
  refreshRoadmap: (projectId: string, enableCompetitorAnalysis?: boolean, refreshCompetitorAnalysis?: boolean) =>
    request('POST', `/roadmap/generate`, { projectId, enableCompetitorAnalysis, refreshCompetitorAnalysis, refresh: true }),
  updateFeatureStatus: (projectId: string, featureId: string, status: string) =>
    request('PATCH', `/roadmap/features/${featureId}?projectId=${projectId}`, { status }),
  convertFeatureToSpec: (projectId: string, featureId: string) =>
    request('POST', `/roadmap/features/${featureId}/convert?projectId=${projectId}`),
  stopRoadmap: (projectId: string) =>
    request('POST', `/roadmap/stop?projectId=${projectId}`),
  onRoadmapProgress: (cb: (projectId: string, status: unknown) => void) =>
    on('roadmap:progress', (data: { projectId: string; status: unknown }) => cb(data.projectId, data.status)),
  onRoadmapComplete: (cb: (projectId: string, roadmap: unknown) => void) =>
    on('roadmap:complete', (data: { projectId: string; roadmap: unknown }) => cb(data.projectId, data.roadmap)),
  onRoadmapError: (cb: (projectId: string, error: string) => void) =>
    on('roadmap:error', (data: { projectId: string; error: string }) => cb(data.projectId, data.error)),
  onRoadmapStopped: (cb: (projectId: string) => void) =>
    on('roadmap:stopped', (data: { projectId: string }) => cb(data.projectId)),

  // ============ Context ============
  getProjectContext: (projectId: string) => request('GET', `/context?projectId=${projectId}`),
  refreshProjectIndex: (projectId: string) =>
    request('POST', `/context/refresh?projectId=${projectId}`),
  getMemoryStatus: (projectId: string) =>
    request('GET', `/context/memory-status?projectId=${projectId}`),
  searchMemories: (projectId: string, query: string) =>
    request('GET', `/context/memories/search?projectId=${projectId}&q=${encodeURIComponent(query)}`),
  getRecentMemories: (projectId: string, limit?: number) =>
    request('GET', `/context/memories?projectId=${projectId}${limit ? `&limit=${limit}` : ''}`),

  // ============ Environment ============
  getProjectEnv: (projectId: string) => request('GET', `/env?projectId=${projectId}`),
  updateProjectEnv: (projectId: string, config: unknown) =>
    request('PUT', `/env?projectId=${projectId}`, config),
  checkClaudeAuth: (projectId: string) =>
    request('GET', `/env/claude-auth?projectId=${projectId}`),
  invokeClaudeSetup: (projectId: string) =>
    request('POST', `/env/claude-setup?projectId=${projectId}`),
  checkSourceToken: () => request('GET', '/env/source-token'),
  getSourceEnv: () => request('GET', '/env/source'),
  updateSourceEnv: (config: unknown) => request('PUT', '/env/source', config),

  // ============ Linear Integration ============
  // ElectronAPI: getLinearTeams(projectId: string)
  getLinearTeams: (projectId: string) => request('GET', `/linear/teams?projectId=${projectId}`),
  // ElectronAPI: getLinearProjects(projectId: string, teamId: string)
  getLinearProjects: (projectId: string, teamId: string) =>
    request('GET', `/linear/projects?projectId=${projectId}&teamId=${teamId}`),
  // ElectronAPI: getLinearIssues(projectId: string, teamId?: string, projectId_?: string)
  getLinearIssues: (projectId: string, teamId?: string, linearProjectId?: string) =>
    request('GET', `/linear/issues?projectId=${projectId}${teamId ? `&teamId=${teamId}` : ''}${linearProjectId ? `&linearProjectId=${linearProjectId}` : ''}`),
  // ElectronAPI: importLinearIssues(projectId: string, issueIds: string[])
  importLinearIssues: (projectId: string, issueIds: string[]) =>
    request('POST', '/linear/import', { projectId, issueIds }),
  // ElectronAPI: checkLinearConnection(projectId: string)
  checkLinearConnection: (projectId: string) => request('GET', `/linear/status?projectId=${projectId}`),

  // ============ GitHub Integration ============
  // ElectronAPI: getGitHubRepositories(projectId: string)
  getGitHubRepositories: (projectId: string) => request('GET', `/github/repos?projectId=${projectId}`),
  // ElectronAPI: getGitHubIssues(projectId: string, state?: 'open' | 'closed' | 'all')
  getGitHubIssues: (projectId: string, state?: 'open' | 'closed' | 'all') =>
    request('GET', `/github/issues?projectId=${projectId}${state ? `&state=${state}` : ''}`),
  // ElectronAPI: getGitHubIssue(projectId: string, issueNumber: number)
  getGitHubIssue: (projectId: string, issueNumber: number) =>
    request('GET', `/github/issues/${issueNumber}?projectId=${projectId}`),
  // ElectronAPI: getIssueComments(projectId: string, issueNumber: number)
  getIssueComments: (projectId: string, issueNumber: number) =>
    request('GET', `/github/issues/${issueNumber}/comments?projectId=${projectId}`),
  // ElectronAPI: checkGitHubConnection(projectId: string)
  checkGitHubConnection: (projectId: string) => request('GET', `/github/status?projectId=${projectId}`),
  // ElectronAPI: investigateGitHubIssue(projectId: string, issueNumber: number, selectedCommentIds?: number[])
  investigateGitHubIssue: (projectId: string, issueNumber: number, selectedCommentIds?: number[]) =>
    request('POST', '/github/investigate', { projectId, issueNumber, selectedCommentIds }),
  // ElectronAPI: importGitHubIssues(projectId: string, issueNumbers: number[])
  importGitHubIssues: (projectId: string, issueNumbers: number[]) =>
    request('POST', '/github/import', { projectId, issueNumbers }),
  // ElectronAPI: createGitHubRelease(projectId, version, releaseNotes, options?)
  createGitHubRelease: (projectId: string, version: string, releaseNotes: string, options?: { draft?: boolean; prerelease?: boolean }) =>
    request('POST', '/github/releases', { projectId, version, releaseNotes, options }),
  // GitHub OAuth operations (gh CLI) - no projectId needed
  checkGitHubCli: () => request('GET', '/github/cli-status'),
  checkGitHubAuth: () => request('GET', '/github/auth-status'),
  startGitHubAuth: () => request('POST', '/github/auth'),
  getGitHubToken: () => request('GET', '/github/token'),
  getGitHubUser: () => request('GET', '/github/user'),
  listGitHubUserRepos: () => request('GET', '/github/user/repos'),
  detectGitHubRepo: (projectPath: string) =>
    request('GET', `/github/detect?path=${encodeURIComponent(projectPath)}`),
  // ElectronAPI: getGitHubBranches(repo: string, token: string)
  getGitHubBranches: (repo: string, token: string) =>
    request('GET', `/github/branches?repo=${encodeURIComponent(repo)}&token=${encodeURIComponent(token)}`),
  // GitHub event listeners with proper data unpacking
  onGitHubInvestigationProgress: (cb: (projectId: string, status: unknown) => void) =>
    on('github:investigationProgress', (data: { projectId: string; status: unknown }) => cb(data.projectId, data.status)),
  onGitHubInvestigationComplete: (cb: (projectId: string, result: unknown) => void) =>
    on('github:investigationComplete', (data: { projectId: string; result: unknown }) => cb(data.projectId, data.result)),
  onGitHubInvestigationError: (cb: (projectId: string, error: string) => void) =>
    on('github:investigationError', (data: { projectId: string; error: string }) => cb(data.projectId, data.error)),

  // ============ Docker & Infrastructure ============
  // ElectronAPI: getInfrastructureStatus(port?: number)
  getInfrastructureStatus: (port?: number) =>
    request('GET', `/docker/status${port ? `?port=${port}` : ''}`),
  // ElectronAPI: startFalkorDB(port?: number)
  startFalkorDB: (port?: number) =>
    request('POST', '/docker/falkordb/start', port ? { port } : undefined),
  stopFalkorDB: () => request('POST', '/docker/falkordb/stop'),
  openDockerDesktop: () => Promise.resolve({ success: false, error: 'Not supported in web mode' }),
  getDockerDownloadUrl: async () => 'https://www.docker.com/products/docker-desktop/',
  validateFalkorDBConnection: (uri: string) =>
    request('POST', '/graphiti/validate-falkordb', { uri }),
  validateOpenAIApiKey: (key: string) =>
    request('POST', '/graphiti/validate-openai', { key }),
  testGraphitiConnection: (falkorDbUri: string, openAiApiKey: string) =>
    request('POST', '/graphiti/test', { falkorDbUri, openAiApiKey }),

  // ============ Auto-Claude Source ============
  checkAutoBuildSource: () => request('GET', '/autobuild/source/check'),
  downloadAutoBuildSource: () => request('POST', '/autobuild/source/download'),
  getAutoBuildSourceVersion: () => request('GET', '/autobuild/source/version'),
  onAutoBuildSourceProgress: (cb: (data: unknown) => void) => on('autobuild:sourceProgress', cb),
  getAutoBuildSourceEnv: () => request('GET', '/autobuild/source/env'),
  updateAutoBuildSourceEnv: (config: unknown) =>
    request('PUT', '/autobuild/source/env', config),
  checkAutoBuildSourceToken: () => request('GET', '/autobuild/source/env/token'),

  // ============ Changelog ============
  // ElectronAPI: getChangelogDoneTasks(projectId: string, tasks?: Task[])
  getChangelogDoneTasks: (projectId: string, tasks?: unknown[]) =>
    request('POST', `/changelog/done-tasks?projectId=${projectId}`, { tasks }),
  // ElectronAPI: loadTaskSpecs(projectId: string, taskIds: string[])
  loadTaskSpecs: (projectId: string, taskIds: string[]) =>
    request('POST', `/changelog/load-specs?projectId=${projectId}`, { taskIds }),
  // ElectronAPI: generateChangelog(request: ChangelogGenerationRequest) - async with progress events
  generateChangelog: (changelogRequest: unknown) =>
    request('POST', '/changelog/generate', changelogRequest),
  // ElectronAPI: saveChangelog(request: ChangelogSaveRequest)
  saveChangelog: (saveRequest: unknown) =>
    request('POST', '/changelog/save', saveRequest),
  // ElectronAPI: readExistingChangelog(projectId: string)
  readExistingChangelog: (projectId: string) =>
    request('GET', `/changelog?projectId=${projectId}`),
  // ElectronAPI: suggestChangelogVersion(projectId: string, taskIds: string[])
  suggestChangelogVersion: (projectId: string, taskIds: string[]) =>
    request('POST', `/changelog/suggest-version?projectId=${projectId}`, { taskIds }),
  // ElectronAPI: suggestChangelogVersionFromCommits(projectId: string, commits: GitCommit[])
  suggestChangelogVersionFromCommits: (projectId: string, commits: unknown[]) =>
    request('POST', `/changelog/suggest-version-from-commits?projectId=${projectId}`, { commits }),
  // ElectronAPI: getChangelogBranches(projectId: string)
  getChangelogBranches: (projectId: string) =>
    request('GET', `/changelog/branches?projectId=${projectId}`),
  // ElectronAPI: getChangelogTags(projectId: string)
  getChangelogTags: (projectId: string) =>
    request('GET', `/changelog/tags?projectId=${projectId}`),
  // ElectronAPI: getChangelogCommitsPreview(projectId, options, mode)
  getChangelogCommitsPreview: (projectId: string, options: unknown, mode: 'git-history' | 'branch-diff') =>
    request('POST', `/changelog/commits-preview?projectId=${projectId}`, { options, mode }),
  // ElectronAPI: saveChangelogImage(projectId, imageData, filename)
  saveChangelogImage: (projectId: string, imageData: string, filename: string) =>
    request('POST', `/changelog/save-image?projectId=${projectId}`, { imageData, filename }),
  // Changelog event listeners with proper data unpacking
  onChangelogGenerationProgress: (cb: (projectId: string, progress: unknown) => void) =>
    on('changelog:generationProgress', (data: { projectId: string; progress: unknown }) => cb(data.projectId, data.progress)),
  onChangelogGenerationComplete: (cb: (projectId: string, result: unknown) => void) =>
    on('changelog:generationComplete', (data: { projectId: string; result: unknown }) => cb(data.projectId, data.result)),
  onChangelogGenerationError: (cb: (projectId: string, error: string) => void) =>
    on('changelog:generationError', (data: { projectId: string; error: string }) => cb(data.projectId, data.error)),

  // ============ Insights ============
  // ElectronAPI: getInsightsSession(projectId: string)
  getInsightsSession: (projectId: string) =>
    request('GET', `/insights/session?projectId=${projectId}`),
  // ElectronAPI: sendInsightsMessage(projectId: string, message: string, modelConfig?: InsightsModelConfig)
  sendInsightsMessage: (projectId: string, message: string, modelConfig?: unknown) =>
    request('POST', `/insights/message?projectId=${projectId}`, { message, modelConfig }),
  // ElectronAPI: clearInsightsSession(projectId: string)
  clearInsightsSession: (projectId: string) =>
    request('DELETE', `/insights/session?projectId=${projectId}`),
  // ElectronAPI: createTaskFromInsights(projectId, title, description, metadata?)
  createTaskFromInsights: (projectId: string, title: string, description: string, metadata?: unknown) =>
    request('POST', `/insights/create-task?projectId=${projectId}`, { title, description, metadata }),
  // ElectronAPI: listInsightsSessions(projectId: string)
  listInsightsSessions: (projectId: string) =>
    request('GET', `/insights/sessions?projectId=${projectId}`),
  // ElectronAPI: newInsightsSession(projectId: string)
  newInsightsSession: (projectId: string) =>
    request('POST', `/insights/sessions?projectId=${projectId}`),
  // ElectronAPI: switchInsightsSession(projectId: string, sessionId: string)
  switchInsightsSession: (projectId: string, sessionId: string) =>
    request('POST', `/insights/sessions/${sessionId}/switch?projectId=${projectId}`),
  // ElectronAPI: deleteInsightsSession(projectId: string, sessionId: string)
  deleteInsightsSession: (projectId: string, sessionId: string) =>
    request('DELETE', `/insights/sessions/${sessionId}?projectId=${projectId}`),
  // ElectronAPI: renameInsightsSession(projectId: string, sessionId: string, newTitle: string)
  renameInsightsSession: (projectId: string, sessionId: string, newTitle: string) =>
    request('PATCH', `/insights/sessions/${sessionId}?projectId=${projectId}`, { name: newTitle }),
  // ElectronAPI: updateInsightsModelConfig(projectId: string, sessionId: string, modelConfig: InsightsModelConfig)
  updateInsightsModelConfig: (projectId: string, sessionId: string, modelConfig: unknown) =>
    request('PATCH', `/insights/sessions/${sessionId}/model-config?projectId=${projectId}`, modelConfig),
  // Insights event listeners with proper data unpacking
  onInsightsStreamChunk: (cb: (projectId: string, chunk: unknown) => void) =>
    on('insights:streamChunk', (data: { projectId: string; chunk: unknown }) => cb(data.projectId, data.chunk)),
  onInsightsStatus: (cb: (projectId: string, status: unknown) => void) =>
    on('insights:status', (data: { projectId: string; status: unknown }) => cb(data.projectId, data.status)),
  onInsightsError: (cb: (projectId: string, error: string) => void) =>
    on('insights:error', (data: { projectId: string; error: string }) => cb(data.projectId, data.error)),

  // ============ Ideation ============
  // ElectronAPI: getIdeation(projectId: string)
  getIdeation: (projectId: string) => request('GET', `/ideation?projectId=${projectId}`),
  // ElectronAPI: generateIdeation(projectId: string, config: IdeationConfig) - void, uses events
  generateIdeation: (projectId: string, config: unknown) =>
    request('POST', '/ideation/generate', { projectId, config }),
  // ElectronAPI: refreshIdeation(projectId: string, config: IdeationConfig) - void, uses events
  refreshIdeation: (projectId: string, config: unknown) =>
    request('POST', '/ideation/generate', { projectId, config, refresh: true }),
  // ElectronAPI: stopIdeation(projectId: string)
  stopIdeation: (projectId: string) => request('POST', '/ideation/stop', { projectId }),
  // ElectronAPI: updateIdeaStatus(projectId: string, ideaId: string, status: IdeationStatus)
  updateIdeaStatus: (projectId: string, ideaId: string, status: string) =>
    request('PATCH', `/ideation/ideas/${ideaId}?projectId=${projectId}`, { status }),
  // ElectronAPI: convertIdeaToTask(projectId: string, ideaId: string)
  convertIdeaToTask: (projectId: string, ideaId: string) =>
    request('POST', `/ideation/ideas/${ideaId}/convert?projectId=${projectId}`),
  // ElectronAPI: dismissIdea(projectId: string, ideaId: string)
  dismissIdea: (projectId: string, ideaId: string) =>
    request('POST', `/ideation/ideas/${ideaId}/dismiss?projectId=${projectId}`),
  // ElectronAPI: dismissAllIdeas(projectId: string)
  dismissAllIdeas: (projectId: string) =>
    request('POST', `/ideation/dismiss-all?projectId=${projectId}`),
  // ElectronAPI: archiveIdea(projectId: string, ideaId: string)
  archiveIdea: (projectId: string, ideaId: string) =>
    request('POST', `/ideation/ideas/${ideaId}/archive?projectId=${projectId}`),
  // ElectronAPI: deleteIdea(projectId: string, ideaId: string)
  deleteIdea: (projectId: string, ideaId: string) =>
    request('DELETE', `/ideation/ideas/${ideaId}?projectId=${projectId}`),
  // ElectronAPI: deleteMultipleIdeas(projectId: string, ideaIds: string[])
  deleteMultipleIdeas: (projectId: string, ideaIds: string[]) =>
    request('POST', `/ideation/delete-multiple?projectId=${projectId}`, { ideaIds }),
  // Ideation event listeners (already with proper data unpacking)
  onIdeationProgress: (cb: (projectId: string, status: unknown) => void) =>
    on('ideation:progress', (data: { projectId: string; status: unknown }) => cb(data.projectId, data.status)),
  onIdeationLog: (cb: (projectId: string, log: string) => void) =>
    on('ideation:log', (data: { projectId: string; log: string }) => cb(data.projectId, data.log)),
  onIdeationComplete: (cb: (projectId: string, session: unknown) => void) =>
    on('ideation:complete', (data: { projectId: string; session: unknown }) => cb(data.projectId, data.session)),
  onIdeationError: (cb: (projectId: string, error: string) => void) =>
    on('ideation:error', (data: { projectId: string; error: string }) => cb(data.projectId, data.error)),
  onIdeationStopped: (cb: (projectId: string) => void) =>
    on('ideation:stopped', (data: { projectId: string }) => cb(data.projectId)),
  onIdeationTypeComplete: (cb: (projectId: string, ideationType: string, ideas: unknown[]) => void) =>
    on('ideation:typeComplete', (data: { projectId: string; ideationType: string; ideas: unknown[] }) =>
      cb(data.projectId, data.ideationType, data.ideas)),
  onIdeationTypeFailed: (cb: (projectId: string, ideationType: string) => void) =>
    on('ideation:typeFailed', (data: { projectId: string; ideationType: string }) =>
      cb(data.projectId, data.ideationType)),

  // ============ File Explorer ============
  listDirectory: (dirPath: string) =>
    request('GET', `/files?path=${encodeURIComponent(dirPath)}`),

  // ============ Git Operations ============
  getGitBranches: (projectPath: string) =>
    request('GET', `/git/branches?path=${encodeURIComponent(projectPath)}`),
  getCurrentGitBranch: (projectPath: string) =>
    request('GET', `/git/current-branch?path=${encodeURIComponent(projectPath)}`),
  detectMainBranch: (projectPath: string) =>
    request('GET', `/git/main-branch?path=${encodeURIComponent(projectPath)}`),
  checkGitStatus: (projectPath: string) =>
    request('GET', `/git/status?path=${encodeURIComponent(projectPath)}`),
  initializeGit: (projectPath: string) =>
    request('POST', `/git/init?path=${encodeURIComponent(projectPath)}`),

  // ============ App Updates ============
  checkAppUpdate: () => Promise.resolve({ success: true, data: null }),
  downloadAppUpdate: () => Promise.resolve({ success: true }),
  installAppUpdate: () => {},
  onAppUpdateAvailable: () => () => {},
  onAppUpdateDownloaded: () => () => {},
  onAppUpdateProgress: () => () => {},

  // ============ Auto-Build Source Updates ============
  checkAutoBuildSourceUpdate: () => Promise.resolve({
    success: true,
    data: { hasUpdate: false, currentVersion: '2.6.5', latestVersion: '2.6.5' }
  }),
  downloadAutoBuildSourceUpdate: () => {},
  onAutoBuildSourceUpdateProgress: () => () => {},

  // ============ Release ============
  // ElectronAPI: getReleaseableVersions(projectId: string)
  getReleaseableVersions: (projectId: string) =>
    request('GET', `/release/versions?projectId=${projectId}`),
  // ElectronAPI: runReleasePreflightCheck(projectId: string, version: string)
  runReleasePreflightCheck: (projectId: string, version: string) =>
    request('POST', `/release/preflight?projectId=${projectId}`, { version }),
  // ElectronAPI: createRelease(request: CreateReleaseRequest) - void, uses events
  createRelease: (releaseRequest: unknown) =>
    request('POST', '/release/create', releaseRequest),
  // Release event listeners with proper data unpacking
  onReleaseProgress: (cb: (projectId: string, progress: unknown) => void) =>
    on('release:progress', (data: { projectId: string; progress: unknown }) => cb(data.projectId, data.progress)),
  onReleaseComplete: (cb: (projectId: string, result: unknown) => void) =>
    on('release:complete', (data: { projectId: string; result: unknown }) => cb(data.projectId, data.result)),
  onReleaseError: (cb: (projectId: string, error: string) => void) =>
    on('release:error', (data: { projectId: string; error: string }) => cb(data.projectId, data.error))
};

export default webAPI;
