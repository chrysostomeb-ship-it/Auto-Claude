/**
 * Helper utilities for Web E2E tests
 * Provides utilities for HTTP API calls and WebSocket connections
 */
import { Page, expect } from '@playwright/test';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import path from 'path';

const API_BASE = 'http://localhost:8080/api';

// Test data directory
export const TEST_DATA_DIR = '/tmp/auto-claude-web-e2e';
export const TEST_PROJECT_DIR = path.join(TEST_DATA_DIR, 'test-project');

/**
 * API helper for making HTTP requests
 */
export const api = {
  async get<T>(endpoint: string): Promise<{ success: boolean; data?: T; error?: string }> {
    const response = await fetch(`${API_BASE}${endpoint}`);
    return response.json();
  },

  async post<T>(endpoint: string, body?: unknown): Promise<{ success: boolean; data?: T; error?: string }> {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return response.json();
  },

  async patch<T>(endpoint: string, body?: unknown): Promise<{ success: boolean; data?: T; error?: string }> {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return response.json();
  },

  async delete<T>(endpoint: string): Promise<{ success: boolean; data?: T; error?: string }> {
    const response = await fetch(`${API_BASE}${endpoint}`, { method: 'DELETE' });
    return response.json();
  },
};

/**
 * Setup test environment with a test project
 */
export function setupTestEnvironment(): void {
  // Use execSync for more reliable directory removal
  const { execSync } = require('child_process');
  try {
    if (existsSync(TEST_DATA_DIR)) {
      execSync(`rm -rf "${TEST_DATA_DIR}"`, { stdio: 'ignore' });
    }
  } catch {
    // Ignore cleanup errors
  }

  mkdirSync(TEST_DATA_DIR, { recursive: true });
  mkdirSync(TEST_PROJECT_DIR, { recursive: true });
  mkdirSync(path.join(TEST_PROJECT_DIR, '.auto-claude', 'specs'), { recursive: true });
  mkdirSync(path.join(TEST_PROJECT_DIR, '.auto-claude', 'roadmap'), { recursive: true });

  // Initialize git repo (required for some features)
  try {
    execSync('git init', { cwd: TEST_PROJECT_DIR, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: TEST_PROJECT_DIR, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: TEST_PROJECT_DIR, stdio: 'ignore' });
  } catch {
    // Ignore git init errors
  }
}

/**
 * Cleanup test environment
 */
export function cleanupTestEnvironment(): void {
  if (existsSync(TEST_DATA_DIR)) {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
}

/**
 * Create a test spec in the test project
 */
export function createTestSpec(
  specId: string,
  title: string = 'Test Feature',
  status: 'pending' | 'in_progress' | 'completed' = 'pending'
): void {
  const specDir = path.join(TEST_PROJECT_DIR, '.auto-claude', 'specs', specId);
  mkdirSync(specDir, { recursive: true });

  const now = new Date().toISOString();
  const chunkStatus = status === 'completed' ? 'completed' : status === 'in_progress' ? 'in_progress' : 'pending';

  writeFileSync(
    path.join(specDir, 'implementation_plan.json'),
    JSON.stringify(
      {
        feature: title,
        description: `Test feature: ${title}`,
        created_at: now,
        updated_at: now,
        status: status,
        phases: [
          {
            phase: 1,
            name: 'Implementation',
            type: 'implementation',
            chunks: [{ id: 'chunk-1', description: 'Implement feature', status: chunkStatus }],
          },
        ],
      },
      null,
      2
    )
  );

  writeFileSync(
    path.join(specDir, 'requirements.json'),
    JSON.stringify({ task_description: `# ${title}\n\nTest description`, workflow_type: 'feature' }, null, 2)
  );
}

/**
 * Create a test roadmap in the test project
 */
export function createTestRoadmap(): void {
  const roadmapDir = path.join(TEST_PROJECT_DIR, '.auto-claude', 'roadmap');
  mkdirSync(roadmapDir, { recursive: true });

  const roadmap = {
    id: 'test-roadmap',
    project_name: 'Test Project',
    version: '1.0',
    vision: 'Test vision',
    target_audience: { primary: 'Developers', secondary: [] },
    phases: [
      {
        id: 'phase-1',
        name: 'Phase 1',
        description: 'First phase',
        order: 1,
        status: 'planned',
        features: [],
      },
    ],
    features: [
      {
        id: 'feature-1',
        title: 'Test Feature 1',
        description: 'A test feature for E2E testing',
        rationale: 'To test the system',
        priority: 'must',
        complexity: 'low',
        impact: 'high',
        phase_id: 'phase-1',
        dependencies: [],
        status: 'under_review',
        acceptance_criteria: ['It should work', 'It should be tested'],
        user_stories: ['As a user, I want this feature'],
      },
      {
        id: 'feature-2',
        title: 'Test Feature 2',
        description: 'Another test feature',
        rationale: 'More testing',
        priority: 'should',
        complexity: 'medium',
        impact: 'medium',
        phase_id: 'phase-1',
        dependencies: ['feature-1'],
        status: 'planned',
        acceptance_criteria: ['Criterion 1'],
        user_stories: [],
      },
    ],
    status: 'draft',
    metadata: {
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  };

  writeFileSync(path.join(roadmapDir, 'roadmap.json'), JSON.stringify(roadmap, null, 2));
}

/**
 * Wait for the app to be ready
 */
export async function waitForAppReady(page: Page): Promise<void> {
  // Wait for the main app container or any content to be visible
  await page.waitForSelector('body', { timeout: 30000 });
  // Wait a bit for React to hydrate
  await page.waitForTimeout(1000);
}

/**
 * Add a project via API
 */
export async function addProjectViaAPI(projectPath: string): Promise<{ success: boolean; data?: unknown; error?: string }> {
  return api.post('/projects', { path: projectPath });
}

/**
 * Get all projects via API
 */
export async function getProjectsViaAPI(): Promise<{ success: boolean; data?: unknown[]; error?: string }> {
  return api.get('/projects');
}

/**
 * Create a task via API
 */
export async function createTaskViaAPI(
  projectId: string,
  title: string,
  description: string
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  return api.post('/tasks', { projectId, title, description });
}

/**
 * Get tasks via API
 */
export async function getTasksViaAPI(projectId: string): Promise<{ success: boolean; data?: unknown[]; error?: string }> {
  return api.get(`/tasks?projectId=${projectId}`);
}

/**
 * Convert a roadmap feature to spec via API
 */
export async function convertFeatureToSpecViaAPI(
  projectId: string,
  featureId: string
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  return api.post(`/roadmap/features/${featureId}/convert?projectId=${projectId}`);
}

/**
 * Get roadmap via API
 */
export async function getRoadmapViaAPI(projectId: string): Promise<{ success: boolean; data?: unknown; error?: string }> {
  return api.get(`/roadmap?projectId=${projectId}`);
}

/**
 * WebSocket helper for real-time events
 */
export class WebSocketHelper {
  private ws: WebSocket | null = null;
  private events: Map<string, unknown[]> = new Map();

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket('ws://localhost:8080/ws');
      this.ws.onopen = () => resolve();
      this.ws.onerror = (err) => reject(err);
      this.ws.onmessage = (event) => {
        try {
          const { event: eventName, data } = JSON.parse(event.data);
          if (!this.events.has(eventName)) {
            this.events.set(eventName, []);
          }
          this.events.get(eventName)!.push(data);
        } catch {
          // Ignore parse errors
        }
      };
    });
  }

  getEvents(eventName: string): unknown[] {
    return this.events.get(eventName) || [];
  }

  clearEvents(): void {
    this.events.clear();
  }

  close(): void {
    this.ws?.close();
  }
}
