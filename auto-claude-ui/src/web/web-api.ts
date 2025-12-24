/**
 * Web API - Browser-compatible API that replaces Electron IPC
 *
 * This module provides the same interface as the Electron preload API,
 * but uses HTTP/WebSocket instead of IPC.
 */

const API_BASE = '/api';

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
          listeners.forEach((callback) => callback(data));
        }
      } catch (e) {
        console.error('[WebAPI] Failed to parse WebSocket message:', e);
      }
    };

    ws.onclose = () => {
      console.log('[WebAPI] WebSocket closed, reconnecting in 2s...');
      setTimeout(() => getWebSocket(), 2000);
    };

    ws.onerror = (error) => {
      console.error('[WebAPI] WebSocket error:', error);
    };
  }
  return ws;
}

// Initialize WebSocket on load
if (typeof window !== 'undefined') {
  getWebSocket();
}

// Helper to subscribe to events
function on(event: string, callback: (...args: unknown[]) => void): () => void {
  if (!eventListeners.has(event)) {
    eventListeners.set(event, new Set());
  }
  eventListeners.get(event)!.add(callback);

  // Return unsubscribe function
  return () => {
    eventListeners.get(event)?.delete(callback);
  };
}

// HTTP request helper
async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<{ success: boolean; data?: T; error?: string }> {
  try {
    const options: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(`${API_BASE}${path}`, options);
    return await response.json();
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

// Project API
export const projectAPI = {
  getProjects: () => request('GET', '/projects'),
  addProject: (path: string) => request('POST', '/projects', { path }),
  removeProject: (id: string) => request('DELETE', `/projects/${id}`),
  updateProjectSettings: (id: string, settings: unknown) =>
    request('PATCH', `/projects/${id}/settings`, settings),
  initializeProject: (id: string) => request('POST', `/projects/${id}/initialize`)
};

// Task API
export const taskAPI = {
  getTasks: (projectId: string) => request('GET', `/tasks?projectId=${projectId}`),
  createTask: (projectId: string, title: string, description: string, complexity?: string) =>
    request('POST', '/tasks', { projectId, title, description, complexity }),
  startTask: (taskId: string, projectId: string) =>
    request('POST', `/tasks/${taskId}/start`, { projectId }),
  stopTask: (taskId: string) => request('POST', `/tasks/${taskId}/stop`),
  getLogs: (taskId: string, projectId: string) =>
    request('GET', `/tasks/${taskId}/logs?projectId=${projectId}`),
  mergeWorktree: (taskId: string, projectId: string) =>
    request('POST', `/tasks/${taskId}/merge`, { projectId }),
  discardWorktree: (taskId: string, projectId: string) =>
    request('POST', `/tasks/${taskId}/discard`, { projectId }),
  deleteTask: (taskId: string, projectId: string) =>
    request('DELETE', `/tasks/${taskId}?projectId=${projectId}`),

  // Events
  onLog: (callback: (data: { taskId: string; log: string }) => void) => on('task:log', callback),
  onProgress: (callback: (data: { taskId: string; progress: unknown }) => void) =>
    on('task:executionProgress', callback),
  onExit: (callback: (data: { taskId: string; code: number }) => void) => on('task:exit', callback)
};

// Terminal API
export const terminalAPI = {
  create: (cwd?: string, cols?: number, rows?: number) =>
    request('POST', '/terminal', { cwd, cols, rows }),
  list: () => request('GET', '/terminal'),
  input: (id: string, data: string) => request('POST', `/terminal/${id}/input`, { data }),
  resize: (id: string, cols: number, rows: number) =>
    request('POST', `/terminal/${id}/resize`, { cols, rows }),
  getBuffer: (id: string) => request('GET', `/terminal/${id}/buffer`),
  destroy: (id: string) => request('DELETE', `/terminal/${id}`),

  // Events
  onOutput: (callback: (data: { id: string; data: string }) => void) =>
    on('terminal:output', callback),
  onExit: (callback: (data: { id: string; exitCode: number }) => void) =>
    on('terminal:exit', callback)
};

// Settings API
export const settingsAPI = {
  get: () => request('GET', '/settings'),
  save: (settings: unknown) => request('PUT', '/settings', settings),
  update: (partial: unknown) => request('PATCH', '/settings', partial)
};

// Agent/Profile API
export const agentAPI = {
  getProfiles: () => request('GET', '/agent/profiles'),
  activateProfile: (id: string) => request('POST', `/agent/profiles/${id}/activate`),
  getAutoSwitchSettings: () => request('GET', '/agent/profiles/auto-switch'),
  updateAutoSwitchSettings: (settings: unknown) =>
    request('PUT', '/agent/profiles/auto-switch', settings),
  getPythonInfo: () => request('GET', '/agent/python'),
  getStatus: () => request('GET', '/agent/status'),

  // Events
  onUsageUpdated: (callback: (data: unknown) => void) => on('claude:usageUpdated', callback),
  onRateLimit: (callback: (data: unknown) => void) => on('claude:sdkRateLimit', callback)
};

// App API
export const appAPI = {
  getVersion: async () => {
    const result = await request<{ version: string }>('GET', '/version');
    return result.data?.version || 'unknown';
  },
  health: () => request('GET', '/health')
};

// Combined API (matches ElectronAPI interface)
export const webAPI = {
  // Project
  getProjects: projectAPI.getProjects,
  addProject: projectAPI.addProject,
  removeProject: projectAPI.removeProject,
  updateProjectSettings: projectAPI.updateProjectSettings,
  initializeProject: projectAPI.initializeProject,

  // Task
  getTasks: taskAPI.getTasks,
  createTask: taskAPI.createTask,
  startTask: taskAPI.startTask,
  stopTask: taskAPI.stopTask,
  getTaskLogs: taskAPI.getLogs,
  mergeWorktree: taskAPI.mergeWorktree,
  discardWorktree: taskAPI.discardWorktree,
  deleteTask: taskAPI.deleteTask,
  onTaskLog: taskAPI.onLog,
  onTaskProgress: taskAPI.onProgress,
  onTaskExit: taskAPI.onExit,

  // Terminal
  createTerminal: terminalAPI.create,
  listTerminals: terminalAPI.list,
  terminalInput: terminalAPI.input,
  terminalResize: terminalAPI.resize,
  getTerminalBuffer: terminalAPI.getBuffer,
  destroyTerminal: terminalAPI.destroy,
  onTerminalOutput: terminalAPI.onOutput,
  onTerminalExit: terminalAPI.onExit,

  // Settings
  getSettings: settingsAPI.get,
  saveSettings: settingsAPI.save,

  // Agent
  getProfiles: agentAPI.getProfiles,
  activateProfile: agentAPI.activateProfile,
  getPythonInfo: agentAPI.getPythonInfo,
  onUsageUpdated: agentAPI.onUsageUpdated,

  // App
  getVersion: appAPI.getVersion
};

// Expose to window (like Electron's contextBridge)
if (typeof window !== 'undefined') {
  (window as unknown as { electronAPI: typeof webAPI }).electronAPI = webAPI;
  (window as unknown as { DEBUG: boolean }).DEBUG = false;
}

export default webAPI;
