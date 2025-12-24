/**
 * Browser mock / Web API for window.electronAPI
 *
 * When running in web mode (not Electron), this module provides:
 * - Real HTTP/WebSocket API if connected to the web server
 * - Mock API for standalone UI development
 */

import type { ElectronAPI } from '../../shared/types';
import webAPI from './web-api';
import {
  projectMock,
  taskMock,
  workspaceMock,
  terminalMock,
  claudeProfileMock,
  contextMock,
  integrationMock,
  changelogMock,
  insightsMock,
  infrastructureMock,
  settingsMock
} from './mocks';

// Check if we're in Electron
const isElectron = typeof window !== 'undefined' && window.electronAPI !== undefined;

// Check if we're connected to the web server (not just file:// or localhost dev)
const isWebServerMode = typeof window !== 'undefined' &&
  !isElectron &&
  (window.location.port === '8080' || window.location.pathname.startsWith('/api'));

/**
 * Create mock electronAPI for browser
 * Aggregates all mock implementations from separate modules
 */
const browserMockAPI: ElectronAPI = {
  // Project Operations
  ...projectMock,

  // Task Operations
  ...taskMock,

  // Workspace Management
  ...workspaceMock,

  // Terminal Operations
  ...terminalMock,

  // Claude Profile Management
  ...claudeProfileMock,

  // Settings
  ...settingsMock,

  // Roadmap Operations
  getRoadmap: async () => ({
    success: true,
    data: null
  }),

  getRoadmapStatus: async () => ({
    success: true,
    data: { isRunning: false }
  }),

  saveRoadmap: async () => ({
    success: true
  }),

  generateRoadmap: (_projectId: string, _enableCompetitorAnalysis?: boolean, _refreshCompetitorAnalysis?: boolean) => {
    console.warn('[Browser Mock] generateRoadmap called');
  },

  refreshRoadmap: (_projectId: string, _enableCompetitorAnalysis?: boolean, _refreshCompetitorAnalysis?: boolean) => {
    console.warn('[Browser Mock] refreshRoadmap called');
  },

  updateFeatureStatus: async () => ({ success: true }),

  convertFeatureToSpec: async (projectId: string, _featureId: string) => ({
    success: true,
    data: {
      id: `task-${Date.now()}`,
      specId: '',
      projectId,
      title: 'Converted Feature',
      description: 'Feature converted from roadmap',
      status: 'backlog' as const,
      subtasks: [],
      logs: [],
      createdAt: new Date(),
      updatedAt: new Date()
    }
  }),

  stopRoadmap: async () => ({ success: true }),

  // Roadmap Event Listeners
  onRoadmapProgress: () => () => {},
  onRoadmapComplete: () => () => {},
  onRoadmapError: () => () => {},
  onRoadmapStopped: () => () => {},
  // Context Operations
  ...contextMock,

  // Environment Configuration & Integration Operations
  ...integrationMock,

  // Changelog & Release Operations
  ...changelogMock,

  // Insights Operations
  ...insightsMock,

  // Infrastructure & Docker Operations
  ...infrastructureMock
};

/**
 * Initialize browser mock or web API if not running in Electron
 */
export function initBrowserMock(): void {
  if (isElectron) {
    // Running in Electron, electronAPI already provided by preload
    return;
  }

  if (isWebServerMode) {
    // Running in web server mode - use real HTTP/WebSocket API
    console.log('%c[Web API] Initializing real web API (HTTP/WebSocket)', 'color: #28a745; font-weight: bold;');
    (window as Window & { electronAPI: ElectronAPI }).electronAPI = webAPI;
  } else {
    // Running in standalone browser - use mocks for UI development
    console.warn('%c[Browser Mock] Initializing mock electronAPI for browser preview', 'color: #f0ad4e; font-weight: bold;');
    (window as Window & { electronAPI: ElectronAPI }).electronAPI = browserMockAPI;
  }
}

// Auto-initialize
initBrowserMock();
