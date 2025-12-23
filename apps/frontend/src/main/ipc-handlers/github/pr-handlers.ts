/**
 * GitHub PR Review IPC handlers
 *
 * Handles AI-powered PR review:
 * 1. List and fetch PRs
 * 2. Run AI review with code analysis
 * 3. Post review comments
 * 4. Apply fixes
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
      console.warn(`[GitHub PR] ${message}`, data);
    } else {
      console.warn(`[GitHub PR] ${message}`);
    }
  }
}

/**
 * PR review finding from AI analysis
 */
export interface PRReviewFinding {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: 'security' | 'quality' | 'style' | 'test' | 'docs' | 'pattern' | 'performance';
  title: string;
  description: string;
  file: string;
  line: number;
  endLine?: number;
  suggestedFix?: string;
  fixable: boolean;
}

/**
 * Complete PR review result
 */
export interface PRReviewResult {
  prNumber: number;
  repo: string;
  success: boolean;
  findings: PRReviewFinding[];
  summary: string;
  overallStatus: 'approve' | 'request_changes' | 'comment';
  reviewId?: number;
  reviewedAt: string;
  error?: string;
}

/**
 * PR data from GitHub API
 */
export interface PRData {
  number: number;
  title: string;
  body: string;
  state: string;
  author: { login: string };
  headRefName: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: Array<{
    path: string;
    additions: number;
    deletions: number;
    status: string;
  }>;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
}

/**
 * PR review progress status
 */
export interface PRReviewProgress {
  phase: 'fetching' | 'analyzing' | 'generating' | 'posting' | 'complete';
  prNumber: number;
  progress: number;
  message: string;
}

/**
 * Get the GitHub directory for a project
 */
function getGitHubDir(project: Project): string {
  return path.join(project.path, '.auto-claude', 'github');
}

/**
 * Get saved PR review result
 */
function getReviewResult(project: Project, prNumber: number): PRReviewResult | null {
  const reviewPath = path.join(getGitHubDir(project), 'pr', `review_${prNumber}.json`);

  if (fs.existsSync(reviewPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(reviewPath, 'utf-8'));
      return {
        prNumber: data.pr_number,
        repo: data.repo,
        success: data.success,
        findings: data.findings?.map((f: Record<string, unknown>) => ({
          id: f.id,
          severity: f.severity,
          category: f.category,
          title: f.title,
          description: f.description,
          file: f.file,
          line: f.line,
          endLine: f.end_line,
          suggestedFix: f.suggested_fix,
          fixable: f.fixable ?? false,
        })) ?? [],
        summary: data.summary ?? '',
        overallStatus: data.overall_status ?? 'comment',
        reviewId: data.review_id,
        reviewedAt: data.reviewed_at ?? new Date().toISOString(),
        error: data.error,
      };
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Send progress update to renderer
 */
function sendProgress(
  mainWindow: BrowserWindow,
  projectId: string,
  status: PRReviewProgress
): void {
  mainWindow.webContents.send(
    IPC_CHANNELS.GITHUB_PR_REVIEW_PROGRESS,
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
  prNumber: number,
  error: string
): void {
  mainWindow.webContents.send(
    IPC_CHANNELS.GITHUB_PR_REVIEW_ERROR,
    projectId,
    { prNumber, error }
  );
}

/**
 * Send completion to renderer
 */
function sendComplete(
  mainWindow: BrowserWindow,
  projectId: string,
  result: PRReviewResult
): void {
  mainWindow.webContents.send(
    IPC_CHANNELS.GITHUB_PR_REVIEW_COMPLETE,
    projectId,
    result
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
 * Run the Python PR reviewer
 */
async function runPRReview(
  project: Project,
  prNumber: number,
  mainWindow: BrowserWindow
): Promise<PRReviewResult> {
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

    const child = spawn(pythonPath, [
      runnerPath,
      '--project', project.path,
      'review-pr',
      prNumber.toString(),
    ], {
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
            prNumber,
            progress: parseInt(match[1], 10),
            message: match[2],
          });
        }
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code: number) => {
      if (code === 0) {
        // Try to load the result from disk
        const result = getReviewResult(project, prNumber);
        if (result) {
          resolve(result);
        } else {
          reject(new Error('Review completed but result not found'));
        }
      } else {
        reject(new Error(stderr || `Review failed with code ${code}`));
      }
    });

    child.on('error', (err: Error) => {
      reject(err);
    });
  });
}

/**
 * Register PR-related handlers
 */
export function registerPRHandlers(
  getMainWindow: () => BrowserWindow | null
): void {
  debugLog('Registering PR handlers');

  // List open PRs
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_PR_LIST,
    async (_, projectId: string): Promise<PRData[]> => {
      debugLog('listPRs handler called', { projectId });
      const project = projectStore.getProject(projectId);
      if (!project) {
        debugLog('Project not found', { projectId });
        return [];
      }

      const config = getGitHubConfig(project);
      if (!config) {
        debugLog('No GitHub config found for project');
        return [];
      }

      try {
        const prs = await githubFetch(
          config.token,
          `/repos/${config.repo}/pulls?state=open&per_page=50`
        ) as Array<{
          number: number;
          title: string;
          body?: string;
          state: string;
          user: { login: string };
          head: { ref: string };
          base: { ref: string };
          additions: number;
          deletions: number;
          changed_files: number;
          created_at: string;
          updated_at: string;
          html_url: string;
        }>;

        debugLog('Fetched PRs', { count: prs.length });
        return prs.map(pr => ({
          number: pr.number,
          title: pr.title,
          body: pr.body ?? '',
          state: pr.state,
          author: { login: pr.user.login },
          headRefName: pr.head.ref,
          baseRefName: pr.base.ref,
          additions: pr.additions,
          deletions: pr.deletions,
          changedFiles: pr.changed_files,
          files: [],
          createdAt: pr.created_at,
          updatedAt: pr.updated_at,
          htmlUrl: pr.html_url,
        }));
      } catch (error) {
        debugLog('Failed to fetch PRs', { error: error instanceof Error ? error.message : error });
        return [];
      }
    }
  );

  // Get single PR
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_PR_GET,
    async (_, projectId: string, prNumber: number): Promise<PRData | null> => {
      debugLog('getPR handler called', { projectId, prNumber });
      const project = projectStore.getProject(projectId);
      if (!project) return null;

      const config = getGitHubConfig(project);
      if (!config) return null;

      try {
        const pr = await githubFetch(
          config.token,
          `/repos/${config.repo}/pulls/${prNumber}`
        ) as {
          number: number;
          title: string;
          body?: string;
          state: string;
          user: { login: string };
          head: { ref: string };
          base: { ref: string };
          additions: number;
          deletions: number;
          changed_files: number;
          created_at: string;
          updated_at: string;
          html_url: string;
        };

        const files = await githubFetch(
          config.token,
          `/repos/${config.repo}/pulls/${prNumber}/files`
        ) as Array<{
          filename: string;
          additions: number;
          deletions: number;
          status: string;
        }>;

        return {
          number: pr.number,
          title: pr.title,
          body: pr.body ?? '',
          state: pr.state,
          author: { login: pr.user.login },
          headRefName: pr.head.ref,
          baseRefName: pr.base.ref,
          additions: pr.additions,
          deletions: pr.deletions,
          changedFiles: pr.changed_files,
          files: files.map(f => ({
            path: f.filename,
            additions: f.additions,
            deletions: f.deletions,
            status: f.status,
          })),
          createdAt: pr.created_at,
          updatedAt: pr.updated_at,
          htmlUrl: pr.html_url,
        };
      } catch {
        return null;
      }
    }
  );

  // Get PR diff
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_PR_GET_DIFF,
    async (_, projectId: string, prNumber: number): Promise<string | null> => {
      const project = projectStore.getProject(projectId);
      if (!project) return null;

      const config = getGitHubConfig(project);
      if (!config) return null;

      try {
        // Use gh CLI to get diff
        const { execSync } = await import('child_process');
        const diff = execSync(`gh pr diff ${prNumber}`, {
          cwd: project.path,
          encoding: 'utf-8',
        });
        return diff;
      } catch {
        return null;
      }
    }
  );

  // Get saved review
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_PR_GET_REVIEW,
    async (_, projectId: string, prNumber: number): Promise<PRReviewResult | null> => {
      const project = projectStore.getProject(projectId);
      if (!project) return null;
      return getReviewResult(project, prNumber);
    }
  );

  // Run AI review
  ipcMain.on(
    IPC_CHANNELS.GITHUB_PR_REVIEW,
    async (_, projectId: string, prNumber: number) => {
      debugLog('runPRReview handler called', { projectId, prNumber });
      const mainWindow = getMainWindow();
      if (!mainWindow) {
        debugLog('No main window available');
        return;
      }

      const project = projectStore.getProject(projectId);
      if (!project) {
        debugLog('Project not found', { projectId });
        sendError(mainWindow, projectId, prNumber, 'Project not found');
        return;
      }

      try {
        debugLog('Starting PR review', { prNumber });
        sendProgress(mainWindow, projectId, {
          phase: 'fetching',
          prNumber,
          progress: 10,
          message: 'Fetching PR data...',
        });

        const result = await runPRReview(project, prNumber, mainWindow);

        debugLog('PR review completed', { prNumber, findingsCount: result.findings.length });
        sendProgress(mainWindow, projectId, {
          phase: 'complete',
          prNumber,
          progress: 100,
          message: 'Review complete!',
        });

        sendComplete(mainWindow, projectId, result);
      } catch (error) {
        debugLog('PR review failed', { prNumber, error: error instanceof Error ? error.message : error });
        sendError(
          mainWindow,
          projectId,
          prNumber,
          error instanceof Error ? error.message : 'Failed to run PR review'
        );
      }
    }
  );

  // Post review to GitHub
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_PR_POST_REVIEW,
    async (_, projectId: string, prNumber: number): Promise<boolean> => {
      debugLog('postPRReview handler called', { projectId, prNumber });
      const project = projectStore.getProject(projectId);
      if (!project) {
        debugLog('Project not found', { projectId });
        return false;
      }

      const result = getReviewResult(project, prNumber);
      if (!result) {
        debugLog('No review result found', { prNumber });
        return false;
      }

      try {
        const { execSync } = await import('child_process');

        // Build review body
        let body = `## 🤖 AI Code Review\n\n${result.summary}\n\n`;

        if (result.findings.length > 0) {
          body += `### Findings (${result.findings.length} total)\n\n`;
          for (const f of result.findings) {
            const emoji = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' }[f.severity] || '⚪';
            body += `#### ${emoji} [${f.severity.toUpperCase()}] ${f.title}\n`;
            body += `📁 \`${f.file}:${f.line}\`\n\n`;
            body += `${f.description}\n\n`;
            if (f.suggestedFix) {
              body += `**Suggested fix:**\n\`\`\`\n${f.suggestedFix}\n\`\`\`\n\n`;
            }
          }
        }

        body += `---\n*This review was generated by AutoCloud AI.*`;

        // Post review
        const eventFlag = result.overallStatus === 'approve' ? '--approve' :
          result.overallStatus === 'request_changes' ? '--request-changes' : '--comment';

        debugLog('Posting review to GitHub', { prNumber, status: result.overallStatus });
        execSync(`gh pr review ${prNumber} ${eventFlag} --body "${body.replace(/"/g, '\\"')}"`, {
          cwd: project.path,
        });

        debugLog('Review posted successfully', { prNumber });
        return true;
      } catch (error) {
        debugLog('Failed to post review', { prNumber, error: error instanceof Error ? error.message : error });
        return false;
      }
    }
  );

  debugLog('PR handlers registered');
}
