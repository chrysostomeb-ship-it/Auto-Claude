/**
 * GitHub Issue Triage IPC handlers
 *
 * Handles AI-powered issue triage:
 * 1. Detect duplicates, spam, feature creep
 * 2. Suggest labels and priority
 * 3. Apply labels to issues
 */

import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { IPC_CHANNELS } from '../../../shared/constants';
import { projectStore } from '../../project-store';
import { getGitHubConfig, githubFetch } from './utils';
import type { Project } from '../../../shared/types';

// Debug logging helper
const DEBUG = process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development';

function debugLog(message: string, data?: unknown): void {
  if (DEBUG) {
    if (data !== undefined) {
      console.warn(`[GitHub Triage] ${message}`, data);
    } else {
      console.warn(`[GitHub Triage] ${message}`);
    }
  }
}

/**
 * Triage categories
 */
export type TriageCategory = 'bug' | 'feature' | 'documentation' | 'question' | 'duplicate' | 'spam' | 'feature_creep';

/**
 * Triage result for a single issue
 */
export interface TriageResult {
  issueNumber: number;
  repo: string;
  category: TriageCategory;
  confidence: number;
  labelsToAdd: string[];
  labelsToRemove: string[];
  isDuplicate: boolean;
  duplicateOf?: number;
  isSpam: boolean;
  isFeatureCreep: boolean;
  suggestedBreakdown: string[];
  priority: 'high' | 'medium' | 'low';
  comment?: string;
  triagedAt: string;
}

/**
 * Triage configuration
 */
export interface TriageConfig {
  enabled: boolean;
  duplicateThreshold: number;
  spamThreshold: number;
  featureCreepThreshold: number;
  enableComments: boolean;
}

/**
 * Triage progress status
 */
export interface TriageProgress {
  phase: 'fetching' | 'analyzing' | 'applying' | 'complete';
  issueNumber?: number;
  progress: number;
  message: string;
  totalIssues: number;
  processedIssues: number;
}

/**
 * Get the GitHub directory for a project
 */
function getGitHubDir(project: Project): string {
  return path.join(project.path, '.auto-claude', 'github');
}

/**
 * Get triage config for a project
 */
function getTriageConfig(project: Project): TriageConfig {
  const configPath = path.join(getGitHubDir(project), 'config.json');

  if (fs.existsSync(configPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return {
        enabled: data.triage_enabled ?? false,
        duplicateThreshold: data.duplicate_threshold ?? 0.80,
        spamThreshold: data.spam_threshold ?? 0.75,
        featureCreepThreshold: data.feature_creep_threshold ?? 0.70,
        enableComments: data.enable_triage_comments ?? false,
      };
    } catch {
      // Return defaults
    }
  }

  return {
    enabled: false,
    duplicateThreshold: 0.80,
    spamThreshold: 0.75,
    featureCreepThreshold: 0.70,
    enableComments: false,
  };
}

/**
 * Save triage config for a project
 */
function saveTriageConfig(project: Project, config: TriageConfig): void {
  const githubDir = getGitHubDir(project);
  fs.mkdirSync(githubDir, { recursive: true });

  const configPath = path.join(githubDir, 'config.json');
  let existingConfig: Record<string, unknown> = {};

  if (fs.existsSync(configPath)) {
    try {
      existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      // Use empty config
    }
  }

  const updatedConfig = {
    ...existingConfig,
    triage_enabled: config.enabled,
    duplicate_threshold: config.duplicateThreshold,
    spam_threshold: config.spamThreshold,
    feature_creep_threshold: config.featureCreepThreshold,
    enable_triage_comments: config.enableComments,
  };

  fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2));
}

/**
 * Get saved triage results for a project
 */
function getTriageResults(project: Project): TriageResult[] {
  const issuesDir = path.join(getGitHubDir(project), 'issues');

  if (!fs.existsSync(issuesDir)) {
    return [];
  }

  const results: TriageResult[] = [];
  const files = fs.readdirSync(issuesDir);

  for (const file of files) {
    if (file.startsWith('triage_') && file.endsWith('.json')) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(issuesDir, file), 'utf-8'));
        results.push({
          issueNumber: data.issue_number,
          repo: data.repo,
          category: data.category,
          confidence: data.confidence,
          labelsToAdd: data.labels_to_add ?? [],
          labelsToRemove: data.labels_to_remove ?? [],
          isDuplicate: data.is_duplicate ?? false,
          duplicateOf: data.duplicate_of,
          isSpam: data.is_spam ?? false,
          isFeatureCreep: data.is_feature_creep ?? false,
          suggestedBreakdown: data.suggested_breakdown ?? [],
          priority: data.priority ?? 'medium',
          comment: data.comment,
          triagedAt: data.triaged_at ?? new Date().toISOString(),
        });
      } catch {
        // Skip invalid files
      }
    }
  }

  return results.sort((a, b) => new Date(b.triagedAt).getTime() - new Date(a.triagedAt).getTime());
}

/**
 * Send progress update to renderer
 */
function sendProgress(
  mainWindow: BrowserWindow,
  projectId: string,
  status: TriageProgress
): void {
  mainWindow.webContents.send(
    IPC_CHANNELS.GITHUB_TRIAGE_PROGRESS,
    projectId,
    status
  );
}

/**
 * Send error to renderer
 */
function sendError(
  mainWindow: BrowserWindow,
  projectId: string,
  error: string
): void {
  mainWindow.webContents.send(
    IPC_CHANNELS.GITHUB_TRIAGE_ERROR,
    projectId,
    { error }
  );
}

/**
 * Send completion to renderer
 */
function sendComplete(
  mainWindow: BrowserWindow,
  projectId: string,
  results: TriageResult[]
): void {
  mainWindow.webContents.send(
    IPC_CHANNELS.GITHUB_TRIAGE_COMPLETE,
    projectId,
    results
  );
}

/**
 * Get the auto-claude backend path
 */
function getBackendPath(project: Project): string | null {
  // The autoBuildPath is the relative path to .auto-claude from project root
  // For mono-repo style projects, the actual backend is in apps/backend
  const autoBuildPath = project.autoBuildPath;
  if (!autoBuildPath) return null;

  // Check if this is a development repo (has apps/backend structure)
  const appsBackendPath = path.join(project.path, 'apps', 'backend');
  if (fs.existsSync(path.join(appsBackendPath, 'runners', 'github', 'runner.py'))) {
    return appsBackendPath;
  }

  // Otherwise, GitHub runner isn't installed
  return null;
}

/**
 * Run the Python triage runner
 */
async function runTriage(
  project: Project,
  issueNumbers: number[] | null,
  applyLabels: boolean,
  mainWindow: BrowserWindow
): Promise<TriageResult[]> {
  return new Promise((resolve, reject) => {
    const backendPath = getBackendPath(project);
    if (!backendPath) {
      reject(new Error('GitHub runner not found. Make sure the GitHub automation module is installed.'));
      return;
    }

    const runnerPath = path.join(backendPath, 'runners', 'github', 'runner.py');
    if (!fs.existsSync(runnerPath)) {
      reject(new Error('GitHub runner not found at: ' + runnerPath));
      return;
    }

    const pythonPath = path.join(backendPath, '.venv', 'bin', 'python');

    const args = [runnerPath, '--project', project.path, 'triage'];

    if (issueNumbers && issueNumbers.length > 0) {
      args.push(...issueNumbers.map(n => n.toString()));
    }

    if (applyLabels) {
      args.push('--apply-labels');
    }

    const child = spawn(pythonPath, args, {
      cwd: backendPath,
      env: {
        ...process.env,
        PYTHONPATH: backendPath,
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
      // Parse progress updates
      const lines = data.toString().split('\n');
      for (const line of lines) {
        const match = line.match(/\[(\d+)%\]\s*(.+)/);
        if (match) {
          sendProgress(mainWindow, project.id, {
            phase: 'analyzing',
            progress: parseInt(match[1], 10),
            message: match[2],
            totalIssues: 0,
            processedIssues: 0,
          });
        }
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code: number) => {
      if (code === 0) {
        // Load results from disk
        const results = getTriageResults(project);
        resolve(results);
      } else {
        reject(new Error(stderr || `Triage failed with code ${code}`));
      }
    });

    child.on('error', (err: Error) => {
      reject(err);
    });
  });
}

/**
 * Register triage-related handlers
 */
export function registerTriageHandlers(
  getMainWindow: () => BrowserWindow | null
): void {
  debugLog('Registering Triage handlers');

  // Get triage config
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_TRIAGE_GET_CONFIG,
    async (_, projectId: string): Promise<TriageConfig | null> => {
      debugLog('getTriageConfig handler called', { projectId });
      const project = projectStore.getProject(projectId);
      if (!project) {
        debugLog('Project not found', { projectId });
        return null;
      }
      const config = getTriageConfig(project);
      debugLog('Triage config loaded', { enabled: config.enabled });
      return config;
    }
  );

  // Save triage config
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_TRIAGE_SAVE_CONFIG,
    async (_, projectId: string, config: TriageConfig): Promise<boolean> => {
      debugLog('saveTriageConfig handler called', { projectId, enabled: config.enabled });
      const project = projectStore.getProject(projectId);
      if (!project) {
        debugLog('Project not found', { projectId });
        return false;
      }
      saveTriageConfig(project, config);
      debugLog('Triage config saved');
      return true;
    }
  );

  // Get triage results
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_TRIAGE_GET_RESULTS,
    async (_, projectId: string): Promise<TriageResult[]> => {
      debugLog('getTriageResults handler called', { projectId });
      const project = projectStore.getProject(projectId);
      if (!project) {
        debugLog('Project not found', { projectId });
        return [];
      }
      const results = getTriageResults(project);
      debugLog('Triage results loaded', { count: results.length });
      return results;
    }
  );

  // Run triage
  ipcMain.on(
    IPC_CHANNELS.GITHUB_TRIAGE_RUN,
    async (_, projectId: string, issueNumbers?: number[]) => {
      debugLog('runTriage handler called', { projectId, issueNumbers });
      const mainWindow = getMainWindow();
      if (!mainWindow) {
        debugLog('No main window available');
        return;
      }

      const project = projectStore.getProject(projectId);
      if (!project) {
        debugLog('Project not found', { projectId });
        sendError(mainWindow, projectId, 'Project not found');
        return;
      }

      try {
        debugLog('Starting triage');
        sendProgress(mainWindow, projectId, {
          phase: 'fetching',
          progress: 10,
          message: 'Fetching issues...',
          totalIssues: 0,
          processedIssues: 0,
        });

        const results = await runTriage(project, issueNumbers ?? null, false, mainWindow);

        debugLog('Triage completed', { resultsCount: results.length });
        sendProgress(mainWindow, projectId, {
          phase: 'complete',
          progress: 100,
          message: `Triaged ${results.length} issues`,
          totalIssues: results.length,
          processedIssues: results.length,
        });

        sendComplete(mainWindow, projectId, results);
      } catch (error) {
        debugLog('Triage failed', { error: error instanceof Error ? error.message : error });
        sendError(
          mainWindow,
          projectId,
          error instanceof Error ? error.message : 'Failed to run triage'
        );
      }
    }
  );

  // Apply labels to issues
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_TRIAGE_APPLY_LABELS,
    async (_, projectId: string, issueNumbers: number[]): Promise<boolean> => {
      debugLog('applyTriageLabels handler called', { projectId, issueNumbers });
      const project = projectStore.getProject(projectId);
      if (!project) {
        debugLog('Project not found', { projectId });
        return false;
      }

      const config = getGitHubConfig(project);
      if (!config) {
        debugLog('No GitHub config found');
        return false;
      }

      try {
        for (const issueNumber of issueNumbers) {
          const triageResults = getTriageResults(project);
          const result = triageResults.find(r => r.issueNumber === issueNumber);

          if (result && result.labelsToAdd.length > 0) {
            debugLog('Applying labels to issue', { issueNumber, labels: result.labelsToAdd });
            // Use gh CLI to add labels
            const { execSync } = await import('child_process');
            execSync(`gh issue edit ${issueNumber} --add-label "${result.labelsToAdd.join(',')}"`, {
              cwd: project.path,
            });
          }
        }
        debugLog('Labels applied successfully');
        return true;
      } catch (error) {
        debugLog('Failed to apply labels', { error: error instanceof Error ? error.message : error });
        return false;
      }
    }
  );

  debugLog('Triage handlers registered');
}
