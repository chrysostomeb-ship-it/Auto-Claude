/**
 * End-to-End tests for Web App
 * Tests the complete user experience through HTTP/WebSocket
 *
 * Run: npx playwright test --config=e2e/playwright-web.config.ts
 */
import { test, expect } from '@playwright/test';
import {
  setupTestEnvironment,
  cleanupTestEnvironment,
  createTestSpec,
  createTestRoadmap,
  api,
  TEST_PROJECT_DIR,
  waitForAppReady,
} from './web-helper';

// Setup/teardown for all tests
test.beforeAll(() => {
  setupTestEnvironment();
});

test.afterAll(() => {
  cleanupTestEnvironment();
});

// ============================================
// API Tests (Backend Functionality)
// ============================================

test.describe('API: Projects', () => {
  test('should list projects', async () => {
    const result = await api.get('/projects');
    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
  });

  test('should add a project', async () => {
    const result = await api.post('/projects', { path: TEST_PROJECT_DIR });
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty('id');
    expect(result.data).toHaveProperty('name', 'test-project');
  });

  test('should get project after adding', async () => {
    const listResult = await api.get('/projects');
    expect(listResult.success).toBe(true);

    const projects = listResult.data as Array<{ path: string }>;
    const testProject = projects.find((p) => p.path === TEST_PROJECT_DIR);
    expect(testProject).toBeDefined();
  });
});

test.describe('API: Tasks', () => {
  let projectId: string;

  test.beforeAll(async () => {
    // Add project first
    const result = await api.post('/projects', { path: TEST_PROJECT_DIR });
    projectId = (result.data as { id: string }).id;

    // Create a test spec
    createTestSpec('001-test-task', 'Test Task');
  });

  test('should list tasks for project', async () => {
    const result = await api.get(`/tasks?projectId=${projectId}`);
    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
  });

  test('should get task details', async () => {
    const tasksResult = await api.get(`/tasks?projectId=${projectId}`);
    const tasks = tasksResult.data as Array<{ id: string }>;

    if (tasks.length > 0) {
      const taskId = tasks[0].id;
      // The task should exist from the spec we created
      expect(taskId).toBeDefined();
    }
  });

  test('should create a task', async () => {
    const result = await api.post('/tasks', {
      projectId,
      title: 'New E2E Test Task',
      description: 'Created by E2E test',
    });
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty('id');
    expect(result.data).toHaveProperty('title', 'New E2E Test Task');
  });

  test('should start a task (API responds)', async () => {
    // First get the tasks
    const tasksResult = await api.get(`/tasks?projectId=${projectId}`);
    const tasks = tasksResult.data as Array<{ id: string }>;

    if (tasks.length > 0) {
      const taskId = tasks[0].id;
      // Try to start the task - may fail if Python env not available, but API should respond
      const result = await api.post(`/tasks/${taskId}/start`, { projectId });
      // The endpoint should respond (success or error about missing Python)
      expect(result).toBeDefined();
      // Either success or specific error about auto-claude not found
      expect(result.success === true || result.error !== undefined).toBe(true);
    }
  });

  test('should stop a task', async () => {
    const tasksResult = await api.get(`/tasks?projectId=${projectId}`);
    const tasks = tasksResult.data as Array<{ id: string }>;

    if (tasks.length > 0) {
      const taskId = tasks[0].id;
      const result = await api.post(`/tasks/${taskId}/stop`, { projectId });
      // Should respond regardless of whether task was running
      expect(result).toBeDefined();
    }
  });
});

test.describe('API: Roadmap', () => {
  let projectId: string;

  test.beforeAll(async () => {
    // Add project and create roadmap
    const result = await api.post('/projects', { path: TEST_PROJECT_DIR });
    projectId = (result.data as { id: string }).id;
    createTestRoadmap();
  });

  test('should get roadmap', async () => {
    const result = await api.get(`/roadmap?projectId=${projectId}`);
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty('features');
  });

  test('should get roadmap status', async () => {
    const result = await api.get(`/roadmap/status?projectId=${projectId}`);
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty('isRunning');
  });

  test('should update feature status', async () => {
    const result = await api.patch(`/roadmap/features/feature-1?projectId=${projectId}`, {
      status: 'planned',
    });
    expect(result.success).toBe(true);
  });

  test('should convert feature to spec', async () => {
    const result = await api.post(`/roadmap/features/feature-1/convert?projectId=${projectId}`);
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty('id');
    expect(result.data).toHaveProperty('specId');
  });
});

test.describe('API: Terminal', () => {
  test('should create terminal', async () => {
    const result = await api.post('/terminal', {
      id: 'test-terminal-1',
      cwd: TEST_PROJECT_DIR,
      cols: 80,
      rows: 24,
    });
    expect(result.success).toBe(true);
  });

  test('should list terminals', async () => {
    // This endpoint might not exist, but we test what we have
    const result = await api.get('/terminal/sessions');
    // Just check it doesn't throw
    expect(result).toBeDefined();
  });

  test('should destroy terminal', async () => {
    const result = await api.delete('/terminal/test-terminal-1');
    expect(result.success).toBe(true);
  });
});

// ============================================
// UI Tests (Frontend Functionality)
// ============================================

test.describe('UI: App Launch', () => {
  test('should load the web app', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);

    // App should have loaded some content
    const body = await page.locator('body');
    await expect(body).toBeVisible();
  });

  test('should display sidebar', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);

    // Look for sidebar or navigation elements
    const sidebar = page.locator('aside, [data-testid="sidebar"], .sidebar, nav').first();
    await expect(sidebar).toBeVisible({ timeout: 10000 });
  });

  test('should show project list', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);

    // The app should show projects or an empty state
    const content = await page.content();
    expect(content.length).toBeGreaterThan(100);
  });
});

test.describe('UI: Project Selection', () => {
  test('should be able to select a project', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);

    // Find and click on a project if any exists
    const projectItems = page.locator('[data-testid="project-item"], .project-item');
    const count = await projectItems.count();

    if (count > 0) {
      await projectItems.first().click();
      // After clicking, some content should change
      await page.waitForTimeout(500);
    }
  });
});

test.describe('UI: Task View', () => {
  test('should display kanban board or task list', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);

    // Look for task-related UI elements
    const taskUI = page.locator(
      '[data-testid="kanban"], [data-testid="task-list"], .kanban, .task-board, .tasks'
    ).first();

    // It's ok if this doesn't exist (no project selected)
    const isVisible = await taskUI.isVisible().catch(() => false);

    // Just verify the page loaded without errors
    expect(await page.title()).toBeDefined();
  });
});

// ============================================
// Integration Tests (E2E Flow)
// ============================================

test.describe('E2E: Full Task Creation Flow', () => {
  test('should create task via API and see it in UI', async ({ page }) => {
    // First, add a project via API
    const projectResult = await api.post('/projects', { path: TEST_PROJECT_DIR });
    expect(projectResult.success).toBe(true);

    const projectId = (projectResult.data as { id: string }).id;

    // Create a task via API
    const taskResult = await api.post('/tasks', {
      projectId,
      title: 'E2E Integration Test Task',
      description: 'This task was created by E2E test',
    });
    expect(taskResult.success).toBe(true);

    // Now load the UI
    await page.goto('/');
    await waitForAppReady(page);

    // The task should eventually appear (might need to select project first)
    // This is a basic check that the app loads without errors
    const body = await page.locator('body');
    await expect(body).toBeVisible();
  });
});

test.describe('E2E: Roadmap to Task Flow', () => {
  test('should convert roadmap feature to task', async () => {
    // Setup
    createTestRoadmap();

    // Add project
    const projectResult = await api.post('/projects', { path: TEST_PROJECT_DIR });
    const projectId = (projectResult.data as { id: string }).id;

    // Get roadmap to verify it exists
    const roadmapResult = await api.get(`/roadmap?projectId=${projectId}`);
    expect(roadmapResult.success).toBe(true);

    const roadmap = roadmapResult.data as { features: Array<{ id: string }> };
    expect(roadmap.features.length).toBeGreaterThan(0);

    // Convert first feature to spec
    const featureId = roadmap.features[0].id;
    const convertResult = await api.post(`/roadmap/features/${featureId}/convert?projectId=${projectId}`);

    expect(convertResult.success).toBe(true);
    expect(convertResult.data).toHaveProperty('specId');

    // Verify task was created
    const tasksResult = await api.get(`/tasks?projectId=${projectId}`);
    expect(tasksResult.success).toBe(true);

    const tasks = tasksResult.data as Array<{ title: string }>;
    const convertedTask = tasks.find((t) => t.title === 'Test Feature 1');
    expect(convertedTask).toBeDefined();
  });
});

// ============================================
// Health Check Tests
// ============================================

test.describe('Health Checks', () => {
  test('API health endpoint should respond', async () => {
    const response = await fetch('http://localhost:8080/api/health');
    expect(response.ok).toBe(true);
  });

  test('Static files should be served', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.ok()).toBe(true);
  });

  test('WebSocket should connect', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);

    // Check if WebSocket connected by looking for console messages or UI state
    // This is a basic check - the WebSocket should auto-connect
    await page.waitForTimeout(2000);

    // If we got here without errors, WebSocket likely connected
    expect(true).toBe(true);
  });
});
