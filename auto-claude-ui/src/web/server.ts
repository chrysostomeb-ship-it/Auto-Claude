/**
 * Auto-Claude Web Server
 *
 * Express server that provides HTTP/WebSocket API for the Auto-Claude UI.
 * This is a standalone implementation that doesn't depend on Electron.
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import * as pty from '@lydell/node-pty';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync, rmdirSync } from 'fs';

const PORT = process.env.PORT || 8080;
const app = express();
const server = createServer(app);

// Data directory - must match Electron's userData path
// Electron uses: app.getPath('userData') -> ~/.config/auto-claude-ui/
const DATA_DIR = path.join(os.homedir(), '.config', 'auto-claude-ui');
const STORE_DIR = path.join(DATA_DIR, 'store');
// Electron stores both projects and settings in projects.json
const PROJECTS_FILE = path.join(STORE_DIR, 'projects.json');

// Ensure data directories exist
if (!existsSync(STORE_DIR)) {
  mkdirSync(STORE_DIR, { recursive: true });
}

// WebSocket server for real-time events
const wss = new WebSocketServer({ server, path: '/ws' });
const wsClients = new Set<WebSocket>();

function broadcast(event: string, data: unknown): void {
  const message = JSON.stringify({ event, data });
  wsClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Terminal management
interface ManagedTerminal {
  id: string;
  pty: pty.IPty;
  cwd: string;
  buffer: string;
}
const terminals = new Map<string, ManagedTerminal>();

// Running tasks
interface RunningTask {
  taskId: string;
  process: ChildProcess;
  projectPath: string;
}
const runningTasks = new Map<string, RunningTask>();

// Middleware
app.use(cors());
app.use(express.json());

// Disable caching for development
app.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// Serve static files
const staticPath = path.join(__dirname, '../../out/renderer');
if (existsSync(staticPath)) {
  app.use(express.static(staticPath, { etag: false, lastModified: false }));
}

// Helper functions
function loadJSON<T>(file: string, defaultValue: T): T {
  try {
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, 'utf-8'));
    }
  } catch {
    // Ignore
  }
  return defaultValue;
}

function saveJSON(file: string, data: unknown): void {
  writeFileSync(file, JSON.stringify(data, null, 2));
}

// Store type matching Electron's electron-store format
interface Store {
  projects: Project[];
  settings: Record<string, unknown>;
}

interface Project {
  id: string;
  name: string;
  path: string;
  autoBuildPath?: string;
  settings?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function loadStore(): Store {
  return loadJSON<Store>(PROJECTS_FILE, { projects: [], settings: {} });
}

function saveStore(store: Store): void {
  saveJSON(PROJECTS_FILE, store);
}

// Get auto-claude path
const AUTO_CLAUDE_SOURCE = '/home/devuser/workdir/Auto-Claude/auto-claude';

function getAutoBuildPath(): string | null {
  const possiblePaths = [
    AUTO_CLAUDE_SOURCE,
    path.resolve(__dirname, '../../../auto-claude'),
    path.resolve(process.cwd(), '../auto-claude'),
    path.resolve(process.cwd(), 'auto-claude')
  ];
  for (const p of possiblePaths) {
    if (existsSync(p) && existsSync(path.join(p, 'run.py'))) {
      return p;
    }
  }
  return null;
}

// ============ API Routes ============

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Version
app.get('/api/version', (_req, res) => {
  const pkg = require('../../package.json');
  res.json({ version: pkg.version, name: pkg.name });
});

// ============ Auto-Claude Source ============

app.get('/api/autobuild/source/check', (_req, res) => {
  const sourcePath = getAutoBuildPath();
  if (sourcePath) {
    res.json({ success: true, data: { exists: true, path: sourcePath } });
  } else {
    res.json({ success: true, data: { exists: false, path: null } });
  }
});

app.get('/api/autobuild/source/version', (_req, res) => {
  const sourcePath = getAutoBuildPath();
  if (!sourcePath) {
    return res.json({ success: false, error: 'Source not found' });
  }
  // Try to get version from the source
  res.json({ success: true, data: { version: '2.6.5', path: sourcePath } });
});

app.get('/api/autobuild/source/env', (_req, res) => {
  const sourcePath = getAutoBuildPath();
  if (!sourcePath) {
    return res.json({ success: false, error: 'Source not found' });
  }
  // Read .env file if exists
  const envPath = path.join(sourcePath, '.env');
  let config = {};
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    content.split('\n').forEach(line => {
      const [key, ...valueParts] = line.split('=');
      if (key && valueParts.length) {
        config[key.trim()] = valueParts.join('=').trim();
      }
    });
  }
  res.json({ success: true, data: config });
});

app.get('/api/autobuild/source/env/token', (_req, res) => {
  const sourcePath = getAutoBuildPath();
  if (!sourcePath) {
    return res.json({ success: true, data: { hasToken: false } });
  }
  const envPath = path.join(sourcePath, '.env');
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    const hasToken = content.includes('CLAUDE_CODE_OAUTH_TOKEN=') &&
                     !content.includes('CLAUDE_CODE_OAUTH_TOKEN=\n') &&
                     !content.includes('CLAUDE_CODE_OAUTH_TOKEN=""');
    res.json({ success: true, data: { hasToken } });
  } else {
    res.json({ success: true, data: { hasToken: false } });
  }
});

// ============ Projects ============

app.get('/api/projects', (_req, res) => {
  const store = loadStore();
  res.json({ success: true, data: store.projects });
});

app.get('/api/projects/:id', (req, res) => {
  const store = loadStore();
  const project = store.projects.find((p) => p.id === req.params.id);
  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }
  res.json({ success: true, data: project });
});

app.post('/api/projects', (req, res) => {
  const { path: projectPath } = req.body;
  if (!projectPath || !existsSync(projectPath)) {
    return res.status(400).json({ success: false, error: 'Invalid project path' });
  }

  const store = loadStore();

  // Check if project with this path already exists (idempotent)
  const existingProject = store.projects.find((p) => p.path === projectPath);
  if (existingProject) {
    return res.json({ success: true, data: existingProject });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const project: Project = {
    id,
    path: projectPath,
    name: path.basename(projectPath),
    autoBuildPath: '.auto-claude',
    settings: {
      model: 'opus',
      memoryBackend: 'file',
      linearSync: false,
      notifications: {
        onTaskComplete: true,
        onTaskFailed: true,
        onReviewNeeded: true,
        sound: false
      }
    },
    createdAt: now,
    updatedAt: now
  };
  store.projects.push(project);
  saveStore(store);
  res.json({ success: true, data: project });
});

app.put('/api/projects/:id', (req, res) => {
  const store = loadStore();
  const idx = store.projects.findIndex((p) => p.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }
  store.projects[idx] = {
    ...store.projects[idx],
    ...req.body,
    updatedAt: new Date().toISOString()
  };
  saveStore(store);
  res.json({ success: true, data: store.projects[idx] });
});

app.delete('/api/projects/:id', (req, res) => {
  const store = loadStore();
  store.projects = store.projects.filter((p) => p.id !== req.params.id);
  saveStore(store);
  res.json({ success: true });
});

// ============ Tasks/Specs ============

app.get('/api/tasks', (req, res) => {
  const { projectId } = req.query;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  // Find specs in project's .auto-claude/specs directory
  const specsDir = path.join(project.path, '.auto-claude', 'specs');
  const tasks: unknown[] = [];

  if (existsSync(specsDir)) {
    const specDirs = readdirSync(specsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const specName of specDirs) {
      const specPath = path.join(specsDir, specName, 'spec.md');
      const planPath = path.join(specsDir, specName, 'implementation_plan.json');

      let title = specName;
      let description = '';
      let status = 'pending';
      let subtasks: unknown[] = [];

      // Try to get title from spec.md first
      if (existsSync(specPath)) {
        const content = readFileSync(specPath, 'utf-8');
        const titleMatch = content.match(/^#\s+(.+)/m);
        if (titleMatch) title = titleMatch[1];
        // Get first paragraph as description
        const descMatch = content.match(/^#.+\n+(.+)/m);
        if (descMatch) description = descMatch[1].slice(0, 200);
      }

      // Get status/subtasks from plan, and title if not found in spec.md
      if (existsSync(planPath)) {
        try {
          const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
          status = plan.status || 'in_progress';
          subtasks = plan.subtasks || plan.phases || [];
          // Get title from plan.feature if not found in spec.md
          if (title === specName && plan.feature) {
            title = plan.feature;
          }
          if (!description && plan.description) {
            description = plan.description.slice(0, 200);
          }
        } catch {
          // Ignore
        }
      }

      tasks.push({
        id: specName,
        specId: specName,
        projectId: projectId,
        title,
        description,
        status,
        subtasks,
        logs: [],
        specDir: path.join(specsDir, specName),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }
  }

  res.json({ success: true, data: tasks });
});

// Create a new task/spec
app.post('/api/tasks', async (req, res) => {
  const { projectId, title, description, metadata } = req.body;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const autoBuildPath = getAutoBuildPath();
  if (!autoBuildPath) {
    return res.status(500).json({ success: false, error: 'auto-claude not found' });
  }

  // Generate spec ID
  const specsDir = path.join(project.path, '.auto-claude', 'specs');
  let specNumber = 1;
  if (existsSync(specsDir)) {
    const existing = readdirSync(specsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => {
        const match = d.name.match(/^(\d+)-/);
        return match ? parseInt(match[1]) : 0;
      });
    if (existing.length > 0) {
      specNumber = Math.max(...existing) + 1;
    }
  }

  const specName = `${String(specNumber).padStart(3, '0')}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50)}`;
  const specDir = path.join(specsDir, specName);

  // Create spec directory and files
  if (!existsSync(specsDir)) {
    mkdirSync(specsDir, { recursive: true });
  }
  mkdirSync(specDir, { recursive: true });

  // Create spec.md
  const specContent = `# ${title}\n\n${description}\n`;
  writeFileSync(path.join(specDir, 'spec.md'), specContent);

  // Create implementation_plan.json
  const plan = {
    status: 'backlog',
    subtasks: [],
    metadata: metadata || {}
  };
  writeFileSync(path.join(specDir, 'implementation_plan.json'), JSON.stringify(plan, null, 2));

  const task = {
    id: specName,
    specId: specName,
    projectId,
    title,
    description,
    status: 'backlog',
    subtasks: [],
    logs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  res.json({ success: true, data: task });
});

// Update task
app.patch('/api/tasks/:id', (req, res) => {
  const taskId = req.params.id;
  const { projectId } = req.query;
  const updates = req.body;

  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const specDir = path.join(project.path, '.auto-claude', 'specs', taskId);
  if (!existsSync(specDir)) {
    return res.status(404).json({ success: false, error: 'Task not found' });
  }

  // Update spec.md if title/description changed
  if (updates.title || updates.description) {
    const specPath = path.join(specDir, 'spec.md');
    let content = existsSync(specPath) ? readFileSync(specPath, 'utf-8') : '';

    if (updates.title) {
      content = content.replace(/^#\s+.+/m, `# ${updates.title}`);
    }
    writeFileSync(specPath, content);
  }

  res.json({ success: true, data: { id: taskId, ...updates } });
});

// Delete task
app.delete('/api/tasks/:id', (req, res) => {
  const taskId = req.params.id;
  const { projectId } = req.query;

  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const specDir = path.join(project.path, '.auto-claude', 'specs', taskId);
  if (existsSync(specDir)) {
    // Remove directory recursively
    const rmrf = (dir: string) => {
      if (existsSync(dir)) {
        readdirSync(dir).forEach(file => {
          const curPath = path.join(dir, file);
          if (statSync(curPath).isDirectory()) {
            rmrf(curPath);
          } else {
            unlinkSync(curPath);
          }
        });
        rmdirSync(dir);
      }
    };
    rmrf(specDir);
  }

  res.json({ success: true });
});

// Get task running status
app.get('/api/tasks/:id/status', (req, res) => {
  const taskId = req.params.id;
  const isRunning = runningTasks.has(taskId);
  res.json({ success: true, data: { isRunning, pid: isRunning ? runningTasks.get(taskId)?.process.pid : null } });
});

// Review task (get review info)
app.get('/api/tasks/:id/review', (req, res) => {
  const taskId = req.params.id;
  const { projectId } = req.query;

  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const qaReportPath = path.join(project.path, '.auto-claude', 'specs', taskId, 'qa_report.md');
  let qaReport = null;
  if (existsSync(qaReportPath)) {
    qaReport = readFileSync(qaReportPath, 'utf-8');
  }

  res.json({ success: true, data: { taskId, qaReport } });
});

// Archive task
app.post('/api/tasks/:id/archive', (req, res) => {
  const taskId = req.params.id;
  const { projectId } = req.body;

  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const planPath = path.join(project.path, '.auto-claude', 'specs', taskId, 'implementation_plan.json');
  if (existsSync(planPath)) {
    try {
      const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
      plan.archivedAt = new Date().toISOString();
      writeFileSync(planPath, JSON.stringify(plan, null, 2));
    } catch {
      // Ignore
    }
  }

  res.json({ success: true });
});

// Unarchive task
app.post('/api/tasks/:id/unarchive', (req, res) => {
  const taskId = req.params.id;
  const { projectId } = req.body;

  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const planPath = path.join(project.path, '.auto-claude', 'specs', taskId, 'implementation_plan.json');
  if (existsSync(planPath)) {
    try {
      const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
      delete plan.archivedAt;
      writeFileSync(planPath, JSON.stringify(plan, null, 2));
    } catch {
      // Ignore
    }
  }

  res.json({ success: true });
});

// List worktrees
app.get('/api/worktrees', (req, res) => {
  const { projectId } = req.query;

  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const worktreesDir = path.join(project.path, '.worktrees');
  const worktrees: unknown[] = [];

  if (existsSync(worktreesDir)) {
    const dirs = readdirSync(worktreesDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const dir of dirs) {
      worktrees.push({
        name: dir,
        path: path.join(worktreesDir, dir)
      });
    }
  }

  res.json({ success: true, data: worktrees });
});

app.post('/api/tasks/:id/start', (req, res) => {
  const { projectId, options } = req.body;
  const taskId = req.params.id;

  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const autoBuildPath = getAutoBuildPath();
  if (!autoBuildPath) {
    return res.status(500).json({ success: false, error: 'auto-claude not found' });
  }

  // Kill existing task if running
  if (runningTasks.has(taskId)) {
    runningTasks.get(taskId)?.process.kill();
    runningTasks.delete(taskId);
  }

  // Start the task
  const pythonPath = path.join(autoBuildPath, '.venv', 'bin', 'python');
  const runScript = path.join(autoBuildPath, 'run.py');

  // Build command args - always use --auto-continue for non-interactive mode
  const args = [runScript, '--spec', taskId, '--auto-continue'];

  // Add --force flag if requested (bypasses review approval check)
  if (options?.force) {
    args.push('--force');
  }

  console.log('[Task Start] Starting task:', {
    taskId,
    pythonPath,
    runScript,
    args,
    cwd: project.path,
    pythonExists: existsSync(pythonPath),
    runScriptExists: existsSync(runScript)
  });

  const child = spawn(pythonPath, args, {
    cwd: project.path,
    env: { ...process.env, PYTHONUNBUFFERED: '1' }
  });

  child.on('error', (err) => {
    console.error('[Task Start] Spawn error:', err);
  });

  runningTasks.set(taskId, {
    taskId,
    process: child,
    projectPath: project.path
  });

  // Broadcast status change to 'in_progress' when task starts
  broadcast('task:statusChange', { taskId, status: 'in_progress' });

  child.stdout?.on('data', (data) => {
    const log = data.toString();
    console.log('[Task stdout]', taskId, log.substring(0, 200));
    broadcast('task:log', { taskId, log });

    // Parse task log markers for progress updates
    if (log.includes('__TASK_LOG_PHASE_START__')) {
      try {
        const match = log.match(/__TASK_LOG_PHASE_START__:(\{.*\})/);
        if (match) {
          const phaseData = JSON.parse(match[1]);
          broadcast('task:executionProgress', { taskId, progress: { phase: phaseData.phase, status: 'running' } });
        }
      } catch { /* ignore parse errors */ }
    }
    if (log.includes('__TASK_LOG_PHASE_END__')) {
      try {
        const match = log.match(/__TASK_LOG_PHASE_END__:(\{.*\})/);
        if (match) {
          const phaseData = JSON.parse(match[1]);
          broadcast('task:executionProgress', { taskId, progress: { phase: phaseData.phase, status: phaseData.success ? 'completed' : 'failed' } });
        }
      } catch { /* ignore parse errors */ }
    }
  });

  child.stderr?.on('data', (data) => {
    const log = data.toString();
    console.log('[Task stderr]', taskId, log.substring(0, 200));
    broadcast('task:log', { taskId, log });
  });

  child.on('exit', (code) => {
    console.log('[Task exit]', taskId, 'code:', code);
    runningTasks.delete(taskId);
    broadcast('task:exit', { taskId, code });
    // Broadcast status change when task completes
    broadcast('task:statusChange', { taskId, status: code === 0 ? 'review' : 'failed' });
  });

  res.json({ success: true });
});

app.post('/api/tasks/:id/stop', (req, res) => {
  const taskId = req.params.id;
  const task = runningTasks.get(taskId);

  if (task) {
    task.process.kill();
    runningTasks.delete(taskId);
    // Broadcast status change when task is stopped
    broadcast('task:statusChange', { taskId, status: 'stopped' });
  }

  res.json({ success: true });
});

// Get task running status
app.get('/api/tasks/:id/status', (req, res) => {
  const taskId = req.params.id;
  const isRunning = runningTasks.has(taskId);
  res.json({ success: true, data: { running: isRunning } });
});

app.post('/api/tasks/:id/recover', (req, res) => {
  const taskId = req.params.id;
  const { projectId, options } = req.body;

  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  // Determine new status
  const newStatus = options?.targetStatus || 'backlog';

  // Update implementation_plan.json to reset status
  const planPath = path.join(project.path, '.auto-claude', 'specs', taskId, 'implementation_plan.json');
  const specDir = path.join(project.path, '.auto-claude', 'specs', taskId);

  if (existsSync(planPath)) {
    try {
      const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
      // Always set the status to allow restart
      plan.status = newStatus;
      writeFileSync(planPath, JSON.stringify(plan, null, 2));
    } catch {
      // Ignore
    }
  }

  // Note: Don't delete review_state.json - it contains approval info
  // Only clear it if explicitly requested (not approved)
  const reviewStatePath = path.join(specDir, 'review_state.json');
  if (existsSync(reviewStatePath) && options?.clearReviewState) {
    try {
      unlinkSync(reviewStatePath);
    } catch {
      // Ignore
    }
  }

  // Delete QA_FIX_REQUEST.md if exists
  const qaFixPath = path.join(specDir, 'QA_FIX_REQUEST.md');
  if (existsSync(qaFixPath)) {
    try {
      unlinkSync(qaFixPath);
    } catch {
      // Ignore
    }
  }

  // Update task status in specs.json
  const specsPath = path.join(project.path, '.auto-claude', 'specs', 'specs.json');
  if (existsSync(specsPath)) {
    try {
      const specs = JSON.parse(readFileSync(specsPath, 'utf-8'));
      const taskIndex = specs.findIndex((s: { id: string }) => s.id === taskId);
      if (taskIndex !== -1) {
        specs[taskIndex].status = newStatus;
        writeFileSync(specsPath, JSON.stringify(specs, null, 2));
      }
    } catch {
      // Ignore
    }
  }

  // Also remove from running tasks if present
  runningTasks.delete(taskId);

  res.json({
    success: true,
    data: {
      taskId,
      recovered: true,
      newStatus,
      message: `Task recovered and set to ${newStatus}`,
      autoRestarted: options?.autoRestart || false
    }
  });
});

// ============ Roadmap ============

app.get('/api/roadmap', (req, res) => {
  const { projectId } = req.query;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const roadmapPath = path.join(project.path, '.auto-claude', 'roadmap', 'roadmap.json');

  if (existsSync(roadmapPath)) {
    try {
      const roadmap = JSON.parse(readFileSync(roadmapPath, 'utf-8'));
      res.json({ success: true, data: roadmap });
    } catch {
      res.json({ success: true, data: null });
    }
  } else {
    res.json({ success: true, data: null });
  }
});

app.get('/api/roadmap/status', (req, res) => {
  const { projectId } = req.query;
  // For now, just return not running - real implementation would track generation status
  res.json({ success: true, data: { isRunning: false, projectId } });
});

app.put('/api/roadmap', (req, res) => {
  const { projectId } = req.query;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const roadmapDir = path.join(project.path, '.auto-claude', 'roadmap');
  const roadmapPath = path.join(roadmapDir, 'roadmap.json');

  if (!existsSync(roadmapDir)) {
    mkdirSync(roadmapDir, { recursive: true });
  }

  writeFileSync(roadmapPath, JSON.stringify(req.body, null, 2));
  res.json({ success: true });
});

// Track roadmap generation processes
const roadmapProcesses = new Map<string, ChildProcess>();

app.post('/api/roadmap/generate', (req, res) => {
  const { projectId, enableCompetitorAnalysis, refreshCompetitorAnalysis, refresh } = req.body;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  // Check if already running
  if (roadmapProcesses.has(projectId)) {
    return res.json({ success: false, error: 'Roadmap generation already in progress' });
  }

  // Find Python and roadmap script
  const autoBuildPath = path.join(__dirname, '../../..', 'auto-claude');
  const pythonPath = path.join(autoBuildPath, '.venv/bin/python');
  const roadmapScript = path.join(autoBuildPath, 'roadmap_runner.py');

  if (!existsSync(pythonPath) || !existsSync(roadmapScript)) {
    broadcast('roadmap:error', { projectId, error: 'Auto-Claude not installed or roadmap script not found' });
    return res.json({ success: true, data: { started: false } });
  }

  const args = [roadmapScript, '--project', project.path];
  if (refresh) args.push('--refresh');
  if (enableCompetitorAnalysis) args.push('--competitor-analysis');
  if (refreshCompetitorAnalysis) args.push('--refresh-competitor');

  try {
    const child = spawn(pythonPath, args, {
      cwd: project.path,
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });

    roadmapProcesses.set(projectId, child);

    child.stdout?.on('data', (data) => {
      const output = data.toString();
      // Try to parse progress updates
      try {
        const lines = output.split('\n').filter((l: string) => l.trim());
        for (const line of lines) {
          if (line.startsWith('{')) {
            const status = JSON.parse(line);
            broadcast('roadmap:progress', { projectId, status });
          }
        }
      } catch {
        // Not JSON, ignore
      }
    });

    child.stderr?.on('data', (data) => {
      console.error(`[Roadmap stderr] ${projectId}:`, data.toString());
    });

    child.on('close', (code) => {
      roadmapProcesses.delete(projectId);
      if (code === 0) {
        // Load and broadcast the generated roadmap
        const roadmapPath = path.join(project.path, '.auto-claude', 'roadmap', 'roadmap.json');
        if (existsSync(roadmapPath)) {
          try {
            const roadmap = JSON.parse(readFileSync(roadmapPath, 'utf-8'));
            broadcast('roadmap:complete', { projectId, roadmap });
          } catch {
            broadcast('roadmap:error', { projectId, error: 'Failed to parse generated roadmap' });
          }
        } else {
          broadcast('roadmap:error', { projectId, error: 'Roadmap file not found after generation' });
        }
      } else {
        broadcast('roadmap:error', { projectId, error: `Roadmap generation failed with code ${code}` });
      }
    });

    child.on('error', (err) => {
      roadmapProcesses.delete(projectId);
      broadcast('roadmap:error', { projectId, error: err.message });
    });

    res.json({ success: true, data: { started: true } });
  } catch (error) {
    broadcast('roadmap:error', { projectId, error: error instanceof Error ? error.message : 'Unknown error' });
    res.json({ success: true, data: { started: false } });
  }
});

app.post('/api/roadmap/stop', (req, res) => {
  const { projectId } = req.query;

  const process = roadmapProcesses.get(projectId as string);
  if (process) {
    process.kill('SIGTERM');
    roadmapProcesses.delete(projectId as string);
    broadcast('roadmap:stopped', { projectId });
    res.json({ success: true });
  } else {
    res.json({ success: false, error: 'No roadmap generation in progress' });
  }
});

app.patch('/api/roadmap/features/:featureId', (req, res) => {
  const { featureId } = req.params;
  const { projectId } = req.query;
  const { status } = req.body;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const roadmapPath = path.join(project.path, '.auto-claude', 'roadmap', 'roadmap.json');

  if (!existsSync(roadmapPath)) {
    return res.json({ success: false, error: 'Roadmap not found' });
  }

  try {
    const roadmap = JSON.parse(readFileSync(roadmapPath, 'utf-8'));

    // Find and update the feature - check both phase.features and top-level features
    let found = false;

    // Check top-level features array (common structure)
    for (const feature of roadmap.features || []) {
      if (feature.id === featureId) {
        feature.status = status;
        found = true;
        break;
      }
    }

    // Also check features nested in phases
    if (!found) {
      for (const phase of roadmap.phases || []) {
        for (const feature of phase.features || []) {
          if (feature.id === featureId) {
            feature.status = status;
            found = true;
            break;
          }
        }
        if (found) break;
      }
    }

    if (!found) {
      return res.json({ success: false, error: 'Feature not found' });
    }

    writeFileSync(roadmapPath, JSON.stringify(roadmap, null, 2));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to update feature status' });
  }
});

app.post('/api/roadmap/features/:featureId/convert', (req, res) => {
  const { featureId } = req.params;
  const { projectId } = req.query;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const roadmapPath = path.join(project.path, '.auto-claude', 'roadmap', 'roadmap.json');

  if (!existsSync(roadmapPath)) {
    return res.json({ success: false, error: 'Roadmap not found' });
  }

  try {
    const roadmap = JSON.parse(readFileSync(roadmapPath, 'utf-8'));

    // Find the feature in roadmap.features array (not nested in phases)
    let feature = roadmap.features?.find((f: { id: string }) => f.id === featureId);

    // Also check phases.features if not found at top level
    if (!feature) {
      for (const phase of roadmap.phases || []) {
        for (const f of phase.features || []) {
          if (f.id === featureId) {
            feature = f;
            break;
          }
        }
        if (feature) break;
      }
    }

    if (!feature) {
      return res.json({ success: false, error: 'Feature not found' });
    }

    // Build task description from feature (match Electron format)
    const taskDescription = `# ${feature.title}

${feature.description || ''}

## Rationale
${feature.rationale || 'N/A'}

## User Stories
${(feature.user_stories || []).map((s: string) => `- ${s}`).join('\n') || 'N/A'}

## Acceptance Criteria
${(feature.acceptance_criteria || []).map((c: string) => `- [ ] ${c}`).join('\n') || 'N/A'}
`;

    // Create spec directory with proper numbering
    const specsDir = path.join(project.path, '.auto-claude', 'specs');
    if (!existsSync(specsDir)) {
      mkdirSync(specsDir, { recursive: true });
    }

    // Find next available spec number
    let specNumber = 1;
    const existingDirs = readdirSync(specsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    const existingNumbers = existingDirs
      .map((name) => {
        const match = name.match(/^(\d+)/);
        return match ? parseInt(match[1], 10) : 0;
      })
      .filter((n) => n > 0);
    if (existingNumbers.length > 0) {
      specNumber = Math.max(...existingNumbers) + 1;
    }

    // Create spec ID with zero-padded number and slugified title
    const slugifiedTitle = feature.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50);
    const specId = `${String(specNumber).padStart(3, '0')}-${slugifiedTitle}`;

    // Create spec directory
    const specDir = path.join(specsDir, specId);
    mkdirSync(specDir, { recursive: true });

    // Create spec.md (REQUIRED by run.py to recognize the spec)
    writeFileSync(path.join(specDir, 'spec.md'), taskDescription);

    // Create implementation_plan.json
    const now = new Date().toISOString();
    const implementationPlan = {
      feature: feature.title,
      description: taskDescription,
      created_at: now,
      updated_at: now,
      status: 'pending',
      phases: [],
    };
    writeFileSync(path.join(specDir, 'implementation_plan.json'), JSON.stringify(implementationPlan, null, 2));

    // Create requirements.json
    const requirements = {
      task_description: taskDescription,
      workflow_type: 'feature',
    };
    writeFileSync(path.join(specDir, 'requirements.json'), JSON.stringify(requirements, null, 2));

    // Create task_metadata.json
    const metadata = {
      sourceType: 'roadmap',
      featureId: feature.id,
      category: 'feature',
    };
    writeFileSync(path.join(specDir, 'task_metadata.json'), JSON.stringify(metadata, null, 2));

    // Update feature with linked spec
    feature.status = 'planned';
    feature.linked_spec_id = specId;
    roadmap.metadata = roadmap.metadata || {};
    roadmap.metadata.updated_at = now;
    writeFileSync(roadmapPath, JSON.stringify(roadmap, null, 2));

    // Create and return Task object (matching Electron format)
    const task = {
      id: specId,
      specId: specId,
      projectId: projectId as string,
      title: feature.title,
      description: taskDescription,
      status: 'backlog',
      subtasks: [],
      logs: [],
      metadata,
      createdAt: now,
      updatedAt: now,
    };

    res.json({ success: true, data: task });
  } catch (error) {
    console.error('[WebServer] Failed to convert feature:', error);
    res.status(500).json({ success: false, error: 'Failed to convert feature to spec' });
  }
});

// ============ Terminal ============

app.post('/api/terminal', (req, res) => {
  try {
    const { id: requestId, cwd, cols = 120, rows = 30 } = req.body;

    // Validate inputs
    const safeCols = Math.max(1, Math.min(Number(cols) || 120, 500));
    const safeRows = Math.max(1, Math.min(Number(rows) || 30, 200));
    const safeCwd = cwd && existsSync(cwd) ? cwd : os.homedir();

    // Use provided ID or generate one
    const id = requestId || `term-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const shell =
      process.platform === 'win32'
        ? process.env.COMSPEC || 'cmd.exe'
        : process.env.SHELL || '/bin/bash';

    const ptyProcess = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: safeCols,
      rows: safeRows,
      cwd: safeCwd,
      env: { ...process.env, TERM: 'xterm-256color' }
    });

    const terminal: ManagedTerminal = {
      id,
      pty: ptyProcess,
      cwd: safeCwd,
      buffer: ''
    };

    ptyProcess.onData((data) => {
      terminal.buffer = (terminal.buffer + data).slice(-100000);
      broadcast('terminal:output', { id, data });
    });

    ptyProcess.onExit(({ exitCode }) => {
      broadcast('terminal:exit', { id, exitCode });
      terminals.delete(id);
    });

    terminals.set(id, terminal);
    res.json({ success: true, data: { id } });
  } catch (error) {
    console.error('[Terminal] Error creating terminal:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create terminal'
    });
  }
});

app.get('/api/terminal', (_req, res) => {
  const list = Array.from(terminals.values()).map((t) => ({ id: t.id, cwd: t.cwd }));
  res.json({ success: true, data: list });
});

app.post('/api/terminal/:id/input', (req, res) => {
  const terminal = terminals.get(req.params.id);
  if (!terminal) {
    return res.status(404).json({ success: false, error: 'Terminal not found' });
  }
  terminal.pty.write(req.body.data);
  res.json({ success: true });
});

app.post('/api/terminal/:id/resize', (req, res) => {
  const terminal = terminals.get(req.params.id);
  if (!terminal) {
    return res.status(404).json({ success: false, error: 'Terminal not found' });
  }
  const { cols, rows } = req.body;
  terminal.pty.resize(cols, rows);
  res.json({ success: true });
});

app.get('/api/terminal/:id/buffer', (req, res) => {
  const terminal = terminals.get(req.params.id);
  if (!terminal) {
    return res.status(404).json({ success: false, error: 'Terminal not found' });
  }
  res.json({ success: true, data: { buffer: terminal.buffer } });
});

app.delete('/api/terminal/:id', (req, res) => {
  const terminal = terminals.get(req.params.id);
  if (terminal) {
    terminal.pty.kill();
    terminals.delete(req.params.id);
  }
  res.json({ success: true });
});

// Invoke Claude in terminal
app.post('/api/terminal/:id/claude', (req, res) => {
  const terminal = terminals.get(req.params.id);
  if (!terminal) {
    return res.status(404).json({ success: false, error: 'Terminal not found' });
  }
  const { task } = req.body;
  // Send claude command to terminal
  terminal.pty.write(`claude "${task?.replace(/"/g, '\\"') || ''}"\r`);
  res.json({ success: true });
});

// Resume Claude session in terminal
app.post('/api/terminal/:id/resume', (req, res) => {
  const terminal = terminals.get(req.params.id);
  if (!terminal) {
    return res.status(404).json({ success: false, error: 'Terminal not found' });
  }
  const { sessionId } = req.body;
  // Send claude resume command
  terminal.pty.write(`claude --resume ${sessionId || ''}\r`);
  res.json({ success: true });
});

// Terminal session storage
const TERMINAL_SESSIONS_DIR = path.join(DATA_DIR, 'terminal-sessions');

app.get('/api/terminal/sessions', (req, res) => {
  const { projectPath } = req.query;
  const sessionsDir = projectPath
    ? path.join(String(projectPath), '.auto-claude', 'terminal-sessions')
    : TERMINAL_SESSIONS_DIR;

  if (!existsSync(sessionsDir)) {
    return res.json({ success: true, data: [] });
  }

  try {
    const files = readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
    const sessions = files.map(f => {
      try {
        return JSON.parse(readFileSync(path.join(sessionsDir, f), 'utf-8'));
      } catch {
        return null;
      }
    }).filter(Boolean);
    res.json({ success: true, data: sessions });
  } catch {
    res.json({ success: true, data: [] });
  }
});

app.post('/api/terminal/sessions/:id/restore', (req, res) => {
  // Restore a terminal session - for now just return success
  res.json({ success: true, data: { restored: true, id: req.params.id } });
});

app.delete('/api/terminal/sessions', (req, res) => {
  const { projectPath } = req.query;
  const sessionsDir = projectPath
    ? path.join(String(projectPath), '.auto-claude', 'terminal-sessions')
    : TERMINAL_SESSIONS_DIR;

  if (existsSync(sessionsDir)) {
    try {
      const files = readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
      files.forEach(f => unlinkSync(path.join(sessionsDir, f)));
    } catch {
      // Ignore errors
    }
  }
  res.json({ success: true });
});

app.get('/api/terminal/sessions/dates', (req, res) => {
  const { projectPath } = req.query;
  const sessionsDir = projectPath
    ? path.join(String(projectPath), '.auto-claude', 'terminal-sessions')
    : TERMINAL_SESSIONS_DIR;

  if (!existsSync(sessionsDir)) {
    return res.json({ success: true, data: [] });
  }

  try {
    const files = readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
    const dates = new Set<string>();
    files.forEach(f => {
      try {
        const session = JSON.parse(readFileSync(path.join(sessionsDir, f), 'utf-8'));
        if (session.createdAt) {
          dates.add(session.createdAt.split('T')[0]);
        }
      } catch {
        // Ignore
      }
    });
    res.json({ success: true, data: Array.from(dates).sort().reverse() });
  } catch {
    res.json({ success: true, data: [] });
  }
});

app.get('/api/terminal/sessions/date/:date', (req, res) => {
  const { projectPath } = req.query;
  const date = req.params.date;
  const sessionsDir = projectPath
    ? path.join(String(projectPath), '.auto-claude', 'terminal-sessions')
    : TERMINAL_SESSIONS_DIR;

  if (!existsSync(sessionsDir)) {
    return res.json({ success: true, data: [] });
  }

  try {
    const files = readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
    const sessions = files.map(f => {
      try {
        const session = JSON.parse(readFileSync(path.join(sessionsDir, f), 'utf-8'));
        if (session.createdAt?.startsWith(date)) {
          return session;
        }
        return null;
      } catch {
        return null;
      }
    }).filter(Boolean);
    res.json({ success: true, data: sessions });
  } catch {
    res.json({ success: true, data: [] });
  }
});

app.post('/api/terminal/sessions/restore-from-date', (req, res) => {
  const { date, sessionId } = req.body;
  // Restore session from date - return success
  res.json({ success: true, data: { restored: true, date, sessionId } });
});

// ============ Claude Profiles ============

const PROFILES_FILE = path.join(DATA_DIR, 'config', 'claude-profiles.json');

interface ProfilesStore {
  version: number;
  profiles: Array<{
    id: string;
    name: string;
    configDir: string;
    isDefault: boolean;
    description?: string;
    createdAt: string;
    lastUsedAt?: string;
    oauthToken?: string;
    tokenCreatedAt?: string;
    rateLimitEvents?: unknown[];
  }>;
  activeProfileId: string | null;
  autoSwitch: {
    enabled: boolean;
    proactiveSwapEnabled: boolean;
    sessionThreshold: number;
    weeklyThreshold: number;
    autoSwitchOnRateLimit: boolean;
    usageCheckInterval: number;
  };
}

function loadProfiles(): ProfilesStore {
  const defaultProfiles: ProfilesStore = {
    version: 3,
    profiles: [{
      id: 'default',
      name: 'Default',
      configDir: path.join(os.homedir(), '.claude'),
      isDefault: true,
      description: 'Default Claude configuration (~/.claude)',
      createdAt: new Date().toISOString()
    }],
    activeProfileId: 'default',
    autoSwitch: {
      enabled: false,
      proactiveSwapEnabled: true,
      sessionThreshold: 95,
      weeklyThreshold: 99,
      autoSwitchOnRateLimit: false,
      usageCheckInterval: 30000
    }
  };

  try {
    if (existsSync(PROFILES_FILE)) {
      return JSON.parse(readFileSync(PROFILES_FILE, 'utf-8'));
    }
  } catch {}
  return defaultProfiles;
}

function saveProfiles(profiles: ProfilesStore): void {
  const dir = path.dirname(PROFILES_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2));
}

app.get('/api/agent/profiles', (_req, res) => {
  const profiles = loadProfiles();
  res.json({
    success: true,
    data: {
      profiles: profiles.profiles.map(p => ({
        ...p,
        oauthToken: p.oauthToken ? '***' : undefined  // Hide token
      })),
      activeProfileId: profiles.activeProfileId
    }
  });
});

app.post('/api/agent/profiles', (req, res) => {
  const { name } = req.body;
  const profiles = loadProfiles();
  const newProfile = {
    id: `profile-${Date.now()}`,
    name,
    configDir: path.join(os.homedir(), '.claude-profiles', name.toLowerCase().replace(/\s+/g, '-')),
    isDefault: false,
    createdAt: new Date().toISOString()
  };
  profiles.profiles.push(newProfile);
  saveProfiles(profiles);
  res.json({ success: true, data: newProfile });
});

app.delete('/api/agent/profiles/:id', (req, res) => {
  const profiles = loadProfiles();
  profiles.profiles = profiles.profiles.filter(p => p.id !== req.params.id);
  if (profiles.activeProfileId === req.params.id) {
    profiles.activeProfileId = profiles.profiles[0]?.id || null;
  }
  saveProfiles(profiles);
  res.json({ success: true });
});

app.patch('/api/agent/profiles/:id', (req, res) => {
  const { name } = req.body;
  const profiles = loadProfiles();
  const profile = profiles.profiles.find(p => p.id === req.params.id);
  if (profile && name) {
    profile.name = name;
    saveProfiles(profiles);
  }
  res.json({ success: true });
});

app.post('/api/agent/profiles/:id/activate', (req, res) => {
  const profiles = loadProfiles();
  profiles.activeProfileId = req.params.id;
  saveProfiles(profiles);
  res.json({ success: true });
});

app.post('/api/agent/profiles/:id/switch', (req, res) => {
  const profiles = loadProfiles();
  profiles.activeProfileId = req.params.id;
  const profile = profiles.profiles.find(p => p.id === req.params.id);
  if (profile) {
    profile.lastUsedAt = new Date().toISOString();
  }
  saveProfiles(profiles);
  res.json({ success: true });
});

app.post('/api/agent/profiles/initialize', (_req, res) => {
  const profiles = loadProfiles();
  res.json({ success: true, data: profiles });
});

app.post('/api/agent/profiles/:id/token', (req, res) => {
  const { token, email } = req.body;
  const profiles = loadProfiles();
  const profile = profiles.profiles.find(p => p.id === req.params.id);
  if (profile) {
    profile.oauthToken = token;
    profile.tokenCreatedAt = new Date().toISOString();
    saveProfiles(profiles);
  }
  res.json({ success: true });
});

app.get('/api/agent/profiles/auto-switch', (_req, res) => {
  const profiles = loadProfiles();
  res.json({ success: true, data: profiles.autoSwitch });
});

app.put('/api/agent/profiles/auto-switch', (req, res) => {
  const profiles = loadProfiles();
  profiles.autoSwitch = { ...profiles.autoSwitch, ...req.body };
  saveProfiles(profiles);
  res.json({ success: true });
});

app.post('/api/agent/profiles/:id/authenticate', (req, res) => {
  // In web mode, authentication would require OAuth flow
  // For now, return instructions
  res.json({
    success: false,
    error: 'OAuth authentication requires running "claude login" in a terminal'
  });
});

// Profile usage
app.get('/api/agent/profiles/:id/usage', (req, res) => {
  const profiles = loadProfiles();
  const profile = profiles.profiles.find(p => p.id === req.params.id);
  if (!profile) {
    return res.status(404).json({ success: false, error: 'Profile not found' });
  }
  // Return usage data - in web mode this is limited
  res.json({
    success: true,
    data: {
      profileId: profile.id,
      sessionUsage: 0,
      weeklyUsage: 0,
      lastUpdated: new Date().toISOString()
    }
  });
});

app.get('/api/agent/profiles/best', (req, res) => {
  const { exclude } = req.query;
  const profiles = loadProfiles();
  // Find best available profile (not excluded, has token)
  const available = profiles.profiles.filter(p =>
    p.id !== exclude && p.oauthToken
  );
  if (available.length > 0) {
    res.json({ success: true, data: available[0] });
  } else {
    res.json({ success: true, data: null });
  }
});

app.post('/api/agent/retry', (req, res) => {
  // Retry with different profile - stub for now
  res.json({ success: true, data: { retried: true } });
});

app.get('/api/agent/usage', (_req, res) => {
  // Global usage info
  res.json({
    success: true,
    data: {
      sessionUsage: 0,
      weeklyUsage: 0,
      lastUpdated: new Date().toISOString()
    }
  });
});

// ============ Project Initialization ============

// Check project version
app.get('/api/projects/:id/version', (req, res) => {
  const store = loadStore();
  const project = store.projects.find((p) => p.id === req.params.id);
  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  // Check if .auto-claude exists and get version
  const autoClaudeDir = path.join(project.path, '.auto-claude');
  const versionFile = path.join(autoClaudeDir, 'version.json');

  if (existsSync(versionFile)) {
    try {
      const version = JSON.parse(readFileSync(versionFile, 'utf-8'));
      res.json({ success: true, data: version });
    } catch {
      res.json({ success: true, data: { version: '2.6.5' } });
    }
  } else if (existsSync(autoClaudeDir)) {
    res.json({ success: true, data: { version: '2.6.5', initialized: true } });
  } else {
    res.json({ success: true, data: { version: null, initialized: false } });
  }
});

// Claude authentication check
app.get('/api/env/claude-auth', (req, res) => {
  const { projectId } = req.query;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  // Check for OAuth token in auto-claude .env
  const autoBuildPath = getAutoBuildPath();
  if (!autoBuildPath) {
    return res.json({ success: true, data: { authenticated: false, method: null } });
  }

  const envPath = path.join(autoBuildPath, '.env');
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    const hasToken = content.includes('CLAUDE_CODE_OAUTH_TOKEN=') &&
                     !content.includes('CLAUDE_CODE_OAUTH_TOKEN=\n') &&
                     !content.includes('CLAUDE_CODE_OAUTH_TOKEN=""');
    res.json({
      success: true,
      data: {
        authenticated: hasToken,
        method: hasToken ? 'oauth' : null
      }
    });
  } else {
    res.json({ success: true, data: { authenticated: false, method: null } });
  }
});

// Check source token (used by ideation/roadmap to check if token exists)
app.get('/api/env/source-token', (_req, res) => {
  const autoBuildPath = getAutoBuildPath();
  if (!autoBuildPath) {
    return res.json({ success: true, data: { hasToken: false, sourcePath: null } });
  }

  const envPath = path.join(autoBuildPath, '.env');
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    const hasToken = content.includes('CLAUDE_CODE_OAUTH_TOKEN=') &&
                     !content.includes('CLAUDE_CODE_OAUTH_TOKEN=\n') &&
                     !content.includes('CLAUDE_CODE_OAUTH_TOKEN=""');
    res.json({
      success: true,
      data: {
        hasToken,
        sourcePath: autoBuildPath
      }
    });
  } else {
    res.json({ success: true, data: { hasToken: false, sourcePath: autoBuildPath } });
  }
});

// Get source environment config
app.get('/api/env/source', (_req, res) => {
  const autoBuildPath = getAutoBuildPath();
  if (!autoBuildPath) {
    return res.json({ success: true, data: {} });
  }

  const envPath = path.join(autoBuildPath, '.env');
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    const env: Record<string, string> = {};
    content.split('\n').forEach(line => {
      const match = line.match(/^([^=]+)=(.*)$/);
      if (match) {
        env[match[1]] = match[2];
      }
    });
    res.json({ success: true, data: env });
  } else {
    res.json({ success: true, data: {} });
  }
});

// Get project environment config
app.get('/api/env', (req, res) => {
  const { projectId } = req.query;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  // Return project settings and environment
  res.json({
    success: true,
    data: {
      model: project.settings?.model || 'opus',
      memoryBackend: project.settings?.memoryBackend || 'file',
      ...project.settings
    }
  });
});

// Update project environment config
app.put('/api/env', (req, res) => {
  const { projectId } = req.query;
  const store = loadStore();
  const idx = store.projects.findIndex((p) => p.id === projectId);

  if (idx === -1) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  store.projects[idx].settings = {
    ...store.projects[idx].settings,
    ...req.body
  };
  store.projects[idx].updatedAt = new Date().toISOString();
  saveStore(store);

  res.json({ success: true });
});

app.post('/api/projects/:id/initialize', (req, res) => {
  const store = loadStore();
  const project = store.projects.find((p) => p.id === req.params.id);
  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const autoBuildPath = getAutoBuildPath();
  if (!autoBuildPath) {
    return res.status(500).json({ success: false, error: 'Auto-Claude source not found' });
  }

  // Create .auto-claude directory structure
  const autoClaudeDir = path.join(project.path, '.auto-claude');
  const specsDir = path.join(autoClaudeDir, 'specs');
  const roadmapDir = path.join(autoClaudeDir, 'roadmap');

  if (!existsSync(specsDir)) mkdirSync(specsDir, { recursive: true });
  if (!existsSync(roadmapDir)) mkdirSync(roadmapDir, { recursive: true });

  res.json({ success: true });
});

// ============ Worktree Operations ============

app.get('/api/tasks/:id/worktree/status', (req, res) => {
  const { projectId } = req.query;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const worktreePath = path.join(project.path, '.worktrees', req.params.id);
  const exists = existsSync(worktreePath);

  res.json({
    success: true,
    data: {
      exists,
      path: exists ? worktreePath : null,
      branch: exists ? `auto-claude/${req.params.id}` : null
    }
  });
});

app.get('/api/tasks/:id/worktree/diff', (req, res) => {
  const { projectId } = req.query;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  // Execute git diff in the worktree
  const worktreePath = path.join(project.path, '.worktrees', req.params.id);
  if (!existsSync(worktreePath)) {
    return res.json({ success: true, data: { diff: '', files: [] } });
  }

  const { execSync } = require('child_process');
  try {
    const diff = execSync('git diff HEAD~1..HEAD', { cwd: worktreePath, encoding: 'utf-8' });
    const filesOutput = execSync('git diff --name-only HEAD~1..HEAD', { cwd: worktreePath, encoding: 'utf-8' });
    const files = filesOutput.trim().split('\n').filter(Boolean);
    res.json({ success: true, data: { diff, files } });
  } catch {
    res.json({ success: true, data: { diff: '', files: [] } });
  }
});

app.post('/api/tasks/:id/worktree/merge', (req, res) => {
  const { projectId } = req.body;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const { execSync } = require('child_process');
  try {
    const branchName = `auto-claude/${req.params.id}`;
    execSync(`git merge ${branchName}`, { cwd: project.path, encoding: 'utf-8' });
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, error: String(error) });
  }
});

app.post('/api/tasks/:id/worktree/discard', (req, res) => {
  const { projectId } = req.body;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const { execSync } = require('child_process');
  const worktreePath = path.join(project.path, '.worktrees', req.params.id);

  try {
    if (existsSync(worktreePath)) {
      execSync(`git worktree remove "${worktreePath}" --force`, { cwd: project.path });
    }
    const branchName = `auto-claude/${req.params.id}`;
    execSync(`git branch -D ${branchName}`, { cwd: project.path, stdio: 'ignore' });
  } catch {
    // Ignore errors
  }

  res.json({ success: true });
});

app.get('/api/tasks/:id/worktree/merge-preview', (req, res) => {
  const { projectId } = req.query;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const { execSync } = require('child_process');
  try {
    const branchName = `auto-claude/${req.params.id}`;
    const commits = execSync(`git log main..${branchName} --oneline`, { cwd: project.path, encoding: 'utf-8' });
    res.json({ success: true, data: { commits: commits.trim().split('\n').filter(Boolean) } });
  } catch {
    res.json({ success: true, data: { commits: [] } });
  }
});

// ============ Context/Memory ============

app.get('/api/context', (req, res) => {
  const { projectId } = req.query;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  // Try project_index.json first (newer format), then context.json
  const indexPath = path.join(project.path, '.auto-claude', 'project_index.json');
  const contextPath = path.join(project.path, '.auto-claude', 'context.json');
  const memoryDir = path.join(project.path, '.auto-claude', 'memory');

  const filePath = existsSync(indexPath) ? indexPath : contextPath;
  let projectIndex = null;

  if (existsSync(filePath)) {
    try {
      projectIndex = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {}
  }

  // Check memory status
  const hasMemory = existsSync(memoryDir);
  let memoryStatus = { enabled: hasMemory, backend: 'file' };
  let memoryState = null;
  let recentMemories: unknown[] = [];

  if (hasMemory) {
    // Try to load memory state
    const stateFile = path.join(memoryDir, 'state.json');
    if (existsSync(stateFile)) {
      try {
        memoryState = JSON.parse(readFileSync(stateFile, 'utf-8'));
      } catch {}
    }
  }

  res.json({
    success: true,
    data: {
      projectIndex,
      memoryStatus,
      memoryState,
      recentMemories
    }
  });
});

app.get('/api/context/memory-status', (req, res) => {
  const { projectId } = req.query;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const memoryDir = path.join(project.path, '.auto-claude', 'memory');
  const hasMemory = existsSync(memoryDir);

  res.json({
    success: true,
    data: {
      backend: 'file',
      enabled: hasMemory,
      path: memoryDir
    }
  });
});

// Refresh project index
app.post('/api/context/refresh', (req, res) => {
  const { projectId } = req.query;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  // In web mode, we return the existing index - full refresh would require running Python
  const indexPath = path.join(project.path, '.auto-claude', 'project_index.json');
  if (existsSync(indexPath)) {
    try {
      const index = JSON.parse(readFileSync(indexPath, 'utf-8'));
      res.json({ success: true, data: index });
    } catch {
      res.json({ success: true, data: null });
    }
  } else {
    res.json({ success: true, data: null });
  }
});

// Search memories
app.get('/api/context/memories/search', (req, res) => {
  const { projectId, q } = req.query;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const memoryDir = path.join(project.path, '.auto-claude', 'memory');
  if (!existsSync(memoryDir)) {
    return res.json({ success: true, data: [] });
  }

  // Simple file-based search
  const results: unknown[] = [];
  try {
    const files = readdirSync(memoryDir).filter(f => f.endsWith('.json'));
    const query = String(q || '').toLowerCase();
    for (const f of files) {
      try {
        const content = readFileSync(path.join(memoryDir, f), 'utf-8');
        if (content.toLowerCase().includes(query)) {
          results.push(JSON.parse(content));
        }
      } catch {
        // Ignore
      }
    }
  } catch {
    // Ignore
  }

  res.json({ success: true, data: results });
});

// Get recent memories
app.get('/api/context/memories', (req, res) => {
  const { projectId, limit } = req.query;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const memoryDir = path.join(project.path, '.auto-claude', 'memory');
  if (!existsSync(memoryDir)) {
    return res.json({ success: true, data: [] });
  }

  const memories: unknown[] = [];
  try {
    const files = readdirSync(memoryDir)
      .filter(f => f.endsWith('.json'))
      .slice(0, Number(limit) || 10);
    for (const f of files) {
      try {
        memories.push(JSON.parse(readFileSync(path.join(memoryDir, f), 'utf-8')));
      } catch {
        // Ignore
      }
    }
  } catch {
    // Ignore
  }

  res.json({ success: true, data: memories });
});

// ============ Ideation ============

// Track running ideation processes
const runningIdeation = new Map<string, ChildProcess>();

app.get('/api/ideation', (req, res) => {
  const { projectId } = req.query;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const ideationPath = path.join(project.path, '.auto-claude', 'ideation', 'ideation.json');
  if (existsSync(ideationPath)) {
    try {
      const ideation = JSON.parse(readFileSync(ideationPath, 'utf-8'));
      // Return null if no ideas exist (to trigger empty state)
      if (!ideation.ideas || ideation.ideas.length === 0) {
        res.json({ success: true, data: null });
      } else {
        res.json({ success: true, data: ideation });
      }
    } catch {
      res.json({ success: true, data: null });
    }
  } else {
    res.json({ success: true, data: null });
  }
});

// Generate ideation
app.post('/api/ideation/generate', (req, res) => {
  const { projectId, config } = req.body;
  const store = loadStore();
  const project = store.projects.find((p: Project) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  // Get autoBuildPath from settings
  const settingsPath = path.join(DATA_DIR, 'settings.json');
  let autoBuildPath = '/home/devuser/workdir/Auto-Claude/auto-claude';
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      if (settings.autoBuildPath) {
        autoBuildPath = settings.autoBuildPath;
      }
    } catch {}
  }

  const ideationRunnerPath = path.join(autoBuildPath, 'runners', 'ideation_runner.py');
  if (!existsSync(ideationRunnerPath)) {
    return res.status(500).json({ success: false, error: `Ideation runner not found at: ${ideationRunnerPath}` });
  }

  // Build arguments
  const args = [ideationRunnerPath, '--project', project.path];

  if (config?.enabledTypes?.length > 0) {
    args.push('--types', config.enabledTypes.join(','));
  }
  if (config?.includeRoadmapContext === false) {
    args.push('--no-roadmap');
  }
  if (config?.includeKanbanContext === false) {
    args.push('--no-kanban');
  }
  if (config?.maxIdeasPerType) {
    args.push('--max-ideas', config.maxIdeasPerType.toString());
  }

  console.log('[WebServer] Starting ideation generation:', args);

  // Use the venv Python from auto-build path
  const pythonPath = path.join(autoBuildPath, '.venv', 'bin', 'python');
  const pythonCmd = existsSync(pythonPath) ? pythonPath : 'python3';

  // Spawn the process
  const proc = spawn(pythonCmd, args, {
    cwd: autoBuildPath,
    env: { ...process.env }
  });

  runningIdeation.set(projectId, proc);

  // Send initial progress
  broadcast('ideation:progress', { projectId, status: { phase: 'analyzing', progress: 10, message: 'Starting ideation analysis...' } });

  let outputBuffer = '';

  proc.stdout.on('data', (data: Buffer) => {
    const text = data.toString();
    outputBuffer += text;
    console.log('[Ideation]', text);

    // Parse progress from output
    if (text.includes('Analyzing')) {
      broadcast('ideation:progress', { projectId, status: { phase: 'analyzing', progress: 30, message: text.trim() } });
    } else if (text.includes('Generating')) {
      broadcast('ideation:progress', { projectId, status: { phase: 'generating', progress: 60, message: text.trim() } });
    }

    // Send log
    broadcast('ideation:log', { projectId, log: text });
  });

  proc.stderr.on('data', (data: Buffer) => {
    const text = data.toString();
    console.error('[Ideation Error]', text);
    broadcast('ideation:log', { projectId, log: text });
  });

  proc.on('close', (code) => {
    runningIdeation.delete(projectId);

    if (code === 0) {
      // Load and send the generated ideation
      const ideationPath = path.join(project.path, '.auto-claude', 'ideation', 'ideation.json');
      if (existsSync(ideationPath)) {
        try {
          const ideation = JSON.parse(readFileSync(ideationPath, 'utf-8'));
          broadcast('ideation:complete', { projectId, session: ideation });
        } catch {
          broadcast('ideation:error', { projectId, error: 'Failed to parse ideation result' });
        }
      } else {
        broadcast('ideation:complete', { projectId, session: { ideas: [] } });
      }
    } else {
      broadcast('ideation:error', { projectId, error: `Ideation process exited with code ${code}` });
    }
  });

  res.json({ success: true, data: { started: true } });
});

// Stop ideation
app.post('/api/ideation/stop', (req, res) => {
  const { projectId } = req.body;
  const proc = runningIdeation.get(projectId);

  if (proc) {
    proc.kill('SIGTERM');
    runningIdeation.delete(projectId);
    broadcast('ideation:stopped', { projectId });
    res.json({ success: true });
  } else {
    res.json({ success: false, error: 'No ideation process running' });
  }
});

// ============ Insights ============

app.get('/api/insights/session', (req, res) => {
  const { projectId } = req.query;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const insightsDir = path.join(project.path, '.auto-claude', 'insights');
  const sessionsPath = path.join(insightsDir, 'sessions.json');

  if (existsSync(sessionsPath)) {
    try {
      const sessions = JSON.parse(readFileSync(sessionsPath, 'utf-8'));
      res.json({ success: true, data: sessions.current || null });
    } catch {
      res.json({ success: true, data: null });
    }
  } else {
    res.json({ success: true, data: null });
  }
});

app.get('/api/insights/sessions', (req, res) => {
  const { projectId } = req.query;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const insightsDir = path.join(project.path, '.auto-claude', 'insights');
  const sessionsPath = path.join(insightsDir, 'sessions.json');

  if (existsSync(sessionsPath)) {
    try {
      const data = JSON.parse(readFileSync(sessionsPath, 'utf-8'));
      res.json({ success: true, data: data.sessions || [] });
    } catch {
      res.json({ success: true, data: [] });
    }
  } else {
    res.json({ success: true, data: [] });
  }
});

// Send insights message
app.post('/api/insights/message', (req, res) => {
  const { projectId } = req.query;
  const { message } = req.body;
  // In web mode, insights streaming would need a different approach
  // For now, broadcast the message via WebSocket
  broadcast('insights:status', { projectId, status: 'processing' });
  // Return immediately - actual processing would be async
  res.json({ success: true });
});

// Clear insights session
app.delete('/api/insights/session', (req, res) => {
  const { projectId } = req.query;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const sessionsPath = path.join(project.path, '.auto-claude', 'insights', 'sessions.json');
  if (existsSync(sessionsPath)) {
    try {
      const data = JSON.parse(readFileSync(sessionsPath, 'utf-8'));
      data.current = null;
      writeFileSync(sessionsPath, JSON.stringify(data, null, 2));
    } catch {
      // Ignore
    }
  }
  res.json({ success: true });
});

// New insights session
app.post('/api/insights/sessions', (req, res) => {
  const { projectId } = req.query;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const insightsDir = path.join(project.path, '.auto-claude', 'insights');
  if (!existsSync(insightsDir)) {
    mkdirSync(insightsDir, { recursive: true });
  }

  const sessionsPath = path.join(insightsDir, 'sessions.json');
  const newSession = {
    id: `session-${Date.now()}`,
    title: 'New Session',
    messages: [],
    createdAt: new Date().toISOString()
  };

  let data = { sessions: [], current: null };
  if (existsSync(sessionsPath)) {
    try {
      data = JSON.parse(readFileSync(sessionsPath, 'utf-8'));
    } catch {
      // Use default
    }
  }
  data.sessions.push(newSession);
  data.current = newSession;
  writeFileSync(sessionsPath, JSON.stringify(data, null, 2));

  res.json({ success: true, data: newSession });
});

// Switch insights session
app.post('/api/insights/sessions/:sessionId/switch', (req, res) => {
  const { projectId } = req.query;
  const { sessionId } = req.params;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const sessionsPath = path.join(project.path, '.auto-claude', 'insights', 'sessions.json');
  if (existsSync(sessionsPath)) {
    try {
      const data = JSON.parse(readFileSync(sessionsPath, 'utf-8'));
      const session = data.sessions.find((s: { id: string }) => s.id === sessionId);
      if (session) {
        data.current = session;
        writeFileSync(sessionsPath, JSON.stringify(data, null, 2));
        res.json({ success: true, data: session });
      } else {
        res.json({ success: true, data: null });
      }
    } catch {
      res.json({ success: true, data: null });
    }
  } else {
    res.json({ success: true, data: null });
  }
});

// Delete insights session
app.delete('/api/insights/sessions/:sessionId', (req, res) => {
  const { projectId } = req.query;
  const { sessionId } = req.params;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const sessionsPath = path.join(project.path, '.auto-claude', 'insights', 'sessions.json');
  if (existsSync(sessionsPath)) {
    try {
      const data = JSON.parse(readFileSync(sessionsPath, 'utf-8'));
      data.sessions = data.sessions.filter((s: { id: string }) => s.id !== sessionId);
      if (data.current?.id === sessionId) {
        data.current = null;
      }
      writeFileSync(sessionsPath, JSON.stringify(data, null, 2));
    } catch {
      // Ignore
    }
  }
  res.json({ success: true });
});

// Rename insights session
app.patch('/api/insights/sessions/:sessionId', (req, res) => {
  const { projectId } = req.query;
  const { sessionId } = req.params;
  const { name } = req.body;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const sessionsPath = path.join(project.path, '.auto-claude', 'insights', 'sessions.json');
  if (existsSync(sessionsPath)) {
    try {
      const data = JSON.parse(readFileSync(sessionsPath, 'utf-8'));
      const session = data.sessions.find((s: { id: string }) => s.id === sessionId);
      if (session && name) {
        session.title = name;
        writeFileSync(sessionsPath, JSON.stringify(data, null, 2));
      }
    } catch {
      // Ignore
    }
  }
  res.json({ success: true });
});

// ============ Changelog ============

app.get('/api/changelog/done-tasks', (req, res) => {
  const { projectId } = req.query;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const specsDir = path.join(project.path, '.auto-claude', 'specs');
  const doneTasks: unknown[] = [];

  if (existsSync(specsDir)) {
    const specDirs = readdirSync(specsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const specName of specDirs) {
      const planPath = path.join(specsDir, specName, 'implementation_plan.json');
      if (existsSync(planPath)) {
        try {
          const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
          if (plan.status === 'done' || plan.status === 'completed') {
            doneTasks.push({ id: specName, title: plan.title || specName });
          }
        } catch {
          // Ignore
        }
      }
    }
  }

  res.json({ success: true, data: doneTasks });
});

app.get('/api/changelog', (req, res) => {
  const { projectId } = req.query;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const changelogPath = path.join(project.path, 'CHANGELOG.md');
  if (existsSync(changelogPath)) {
    const content = readFileSync(changelogPath, 'utf-8');
    res.json({ success: true, data: content });
  } else {
    res.json({ success: true, data: null });
  }
});

// ============ Git Operations ============

app.get('/api/git/branches', (req, res) => {
  const { path: projectPath } = req.query;
  if (!projectPath || !existsSync(String(projectPath))) {
    return res.json({ success: true, data: [] });
  }

  const { execSync } = require('child_process');
  try {
    const output = execSync('git branch -a', { cwd: String(projectPath), encoding: 'utf-8' });
    const branches = output.trim().split('\n').map((b: string) => b.trim().replace(/^\* /, ''));
    res.json({ success: true, data: branches });
  } catch {
    res.json({ success: true, data: [] });
  }
});

app.get('/api/git/current-branch', (req, res) => {
  const { path: projectPath } = req.query;
  if (!projectPath || !existsSync(String(projectPath))) {
    return res.json({ success: true, data: null });
  }

  const { execSync } = require('child_process');
  try {
    const branch = execSync('git branch --show-current', { cwd: String(projectPath), encoding: 'utf-8' }).trim();
    res.json({ success: true, data: branch });
  } catch {
    res.json({ success: true, data: null });
  }
});

app.get('/api/git/main-branch', (req, res) => {
  const { path: projectPath } = req.query;
  if (!projectPath || !existsSync(String(projectPath))) {
    return res.json({ success: true, data: 'main' });
  }

  const { execSync } = require('child_process');
  try {
    // Check if main exists
    execSync('git rev-parse --verify main', { cwd: String(projectPath), stdio: 'ignore' });
    res.json({ success: true, data: 'main' });
  } catch {
    try {
      execSync('git rev-parse --verify master', { cwd: String(projectPath), stdio: 'ignore' });
      res.json({ success: true, data: 'master' });
    } catch {
      res.json({ success: true, data: 'main' });
    }
  }
});

app.get('/api/git/status', (req, res) => {
  const { path: projectPath } = req.query;
  if (!projectPath || !existsSync(String(projectPath))) {
    return res.json({ success: true, data: { isGitRepo: false, hasCommits: false } });
  }

  const { execSync } = require('child_process');
  try {
    execSync('git rev-parse --git-dir', { cwd: String(projectPath), stdio: 'ignore' });
    const status = execSync('git status --porcelain', { cwd: String(projectPath), encoding: 'utf-8' });

    // Check if there are any commits
    let hasCommits = false;
    try {
      execSync('git rev-parse HEAD', { cwd: String(projectPath), stdio: 'ignore' });
      hasCommits = true;
    } catch {
      hasCommits = false;
    }

    res.json({
      success: true,
      data: {
        isGitRepo: true,
        hasCommits,
        hasChanges: status.trim().length > 0,
        changes: status.trim().split('\n').filter(Boolean)
      }
    });
  } catch {
    res.json({ success: true, data: { isGitRepo: false, hasCommits: false } });
  }
});

// ============ File Explorer ============

app.get('/api/files', (req, res) => {
  const { path: dirPath } = req.query;
  if (!dirPath || !existsSync(String(dirPath))) {
    return res.json({ success: false, error: 'Path not found' });
  }

  try {
    const entries = readdirSync(String(dirPath), { withFileTypes: true });
    const files = entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      path: path.join(String(dirPath), entry.name)
    }));
    res.json({ success: true, data: files });
  } catch (error) {
    res.json({ success: false, error: String(error) });
  }
});

// ============ Task Logs ============

app.get('/api/tasks/:id/logs', (req, res) => {
  const { projectId } = req.query;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const logsPath = path.join(project.path, '.auto-claude', 'specs', req.params.id, 'logs');
  const logs: string[] = [];

  if (existsSync(logsPath)) {
    const logFiles = readdirSync(logsPath).filter((f) => f.endsWith('.log'));
    for (const logFile of logFiles) {
      const content = readFileSync(path.join(logsPath, logFile), 'utf-8');
      logs.push(content);
    }
  }

  res.json({ success: true, data: logs.join('\n') });
});

// ============ Settings ============

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

function loadAppSettings(): Record<string, unknown> {
  try {
    if (existsSync(SETTINGS_FILE)) {
      return JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}

function saveAppSettings(settings: Record<string, unknown>): void {
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

app.get('/api/settings', (_req, res) => {
  const settings = loadAppSettings();
  res.json({ success: true, data: settings });
});

app.put('/api/settings', (req, res) => {
  const currentSettings = loadAppSettings();
  const updatedSettings = { ...currentSettings, ...req.body };
  saveAppSettings(updatedSettings);
  res.json({ success: true });
});

// ============ Linear Integration ============

app.get('/api/linear/teams', (req, res) => {
  // Linear requires API token - return empty for now
  res.json({ success: true, data: [] });
});

app.get('/api/linear/projects', (req, res) => {
  res.json({ success: true, data: [] });
});

app.get('/api/linear/issues', (req, res) => {
  res.json({ success: true, data: [] });
});

app.get('/api/linear/status', (req, res) => {
  res.json({
    success: true,
    data: {
      connected: false,
      message: 'Linear integration requires API token configuration'
    }
  });
});

// ============ GitHub Integration ============

app.get('/api/github/repos', (req, res) => {
  res.json({ success: true, data: [] });
});

app.get('/api/github/issues', (req, res) => {
  const { owner, repo, state } = req.query;
  if (!owner || !repo) {
    return res.json({ success: true, data: [] });
  }

  const { execSync } = require('child_process');
  try {
    const stateArg = state ? `--state ${state}` : '';
    const output = execSync(`gh issue list --repo ${owner}/${repo} ${stateArg} --json number,title,state,body,labels`, {
      encoding: 'utf-8',
      timeout: 10000
    });
    const issues = JSON.parse(output);
    res.json({ success: true, data: issues });
  } catch {
    res.json({ success: true, data: [] });
  }
});

app.get('/api/github/issues/:number', (req, res) => {
  const { owner, repo } = req.query;
  const { number } = req.params;
  if (!owner || !repo) {
    return res.json({ success: false, error: 'Missing owner or repo' });
  }

  const { execSync } = require('child_process');
  try {
    const output = execSync(`gh issue view ${number} --repo ${owner}/${repo} --json number,title,state,body,labels,author,createdAt`, {
      encoding: 'utf-8',
      timeout: 10000
    });
    const issue = JSON.parse(output);
    res.json({ success: true, data: issue });
  } catch {
    res.json({ success: false, error: 'Issue not found' });
  }
});

app.get('/api/github/issues/:number/comments', (req, res) => {
  const { owner, repo } = req.query;
  const { number } = req.params;
  if (!owner || !repo) {
    return res.json({ success: true, data: [] });
  }

  const { execSync } = require('child_process');
  try {
    const output = execSync(`gh issue view ${number} --repo ${owner}/${repo} --json comments`, {
      encoding: 'utf-8',
      timeout: 10000
    });
    const data = JSON.parse(output);
    res.json({ success: true, data: data.comments || [] });
  } catch {
    res.json({ success: true, data: [] });
  }
});

app.get('/api/github/status', (req, res) => {
  const { execSync } = require('child_process');
  try {
    execSync('gh auth status', { encoding: 'utf-8', timeout: 5000 });
    res.json({ success: true, data: { connected: true } });
  } catch {
    res.json({ success: true, data: { connected: false } });
  }
});

app.get('/api/github/cli-status', (_req, res) => {
  const { execSync } = require('child_process');
  try {
    const version = execSync('gh --version', { encoding: 'utf-8', timeout: 5000 });
    res.json({ success: true, data: { installed: true, version: version.trim().split('\n')[0] } });
  } catch {
    res.json({ success: true, data: { installed: false } });
  }
});

app.get('/api/github/auth-status', (_req, res) => {
  const { execSync } = require('child_process');
  try {
    const output = execSync('gh auth status 2>&1', { encoding: 'utf-8', timeout: 5000 });
    const authenticated = output.includes('Logged in');
    res.json({ success: true, data: { authenticated } });
  } catch {
    res.json({ success: true, data: { authenticated: false } });
  }
});

app.post('/api/github/auth', (_req, res) => {
  res.json({
    success: false,
    error: 'GitHub authentication requires running "gh auth login" in a terminal'
  });
});

app.get('/api/github/token', (_req, res) => {
  const { execSync } = require('child_process');
  try {
    const token = execSync('gh auth token', { encoding: 'utf-8', timeout: 5000 }).trim();
    res.json({ success: true, data: { token } });
  } catch {
    res.json({ success: false, error: 'No token available' });
  }
});

app.get('/api/github/user', (_req, res) => {
  const { execSync } = require('child_process');
  try {
    const output = execSync('gh api user', { encoding: 'utf-8', timeout: 5000 });
    const user = JSON.parse(output);
    res.json({ success: true, data: { username: user.login, name: user.name } });
  } catch {
    res.json({ success: false, error: 'Failed to get user' });
  }
});

app.get('/api/github/user/repos', (_req, res) => {
  const { execSync } = require('child_process');
  try {
    const output = execSync('gh repo list --json name,owner,url --limit 50', { encoding: 'utf-8', timeout: 10000 });
    const repos = JSON.parse(output);
    res.json({ success: true, data: { repos } });
  } catch {
    res.json({ success: true, data: { repos: [] } });
  }
});

app.get('/api/github/detect', (req, res) => {
  const { path: projectPath } = req.query;
  if (!projectPath || !existsSync(String(projectPath))) {
    return res.json({ success: true, data: null });
  }

  const { execSync } = require('child_process');
  try {
    const remote = execSync('git remote get-url origin', { cwd: String(projectPath), encoding: 'utf-8' }).trim();
    // Parse GitHub URL
    const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
    if (match) {
      res.json({ success: true, data: match[1] });
    } else {
      res.json({ success: true, data: null });
    }
  } catch {
    res.json({ success: true, data: null });
  }
});

app.get('/api/github/branches', (req, res) => {
  const { owner, repo } = req.query;
  if (!owner || !repo) {
    return res.json({ success: true, data: [] });
  }

  const { execSync } = require('child_process');
  try {
    const output = execSync(`gh api repos/${owner}/${repo}/branches --jq '.[].name'`, { encoding: 'utf-8', timeout: 10000 });
    const branches = output.trim().split('\n').filter(Boolean);
    res.json({ success: true, data: branches });
  } catch {
    res.json({ success: true, data: [] });
  }
});

// ============ Docker & Infrastructure ============

app.get('/api/docker/status', (_req, res) => {
  const { execSync } = require('child_process');
  try {
    execSync('docker info', { encoding: 'utf-8', timeout: 5000, stdio: 'ignore' });
    res.json({
      success: true,
      data: {
        dockerRunning: true,
        falkorDbRunning: false,
        falkorDbPort: 6379
      }
    });
  } catch {
    res.json({
      success: true,
      data: {
        dockerRunning: false,
        falkorDbRunning: false,
        falkorDbPort: null
      }
    });
  }
});

app.post('/api/docker/falkordb/start', (req, res) => {
  const { port } = req.body;
  const { execSync } = require('child_process');
  try {
    execSync(`docker run -d --name falkordb -p ${port || 6379}:6379 falkordb/falkordb`, {
      encoding: 'utf-8',
      timeout: 30000
    });
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, error: String(error) });
  }
});

app.post('/api/docker/falkordb/stop', (_req, res) => {
  const { execSync } = require('child_process');
  try {
    execSync('docker stop falkordb && docker rm falkordb', { encoding: 'utf-8', timeout: 10000 });
    res.json({ success: true });
  } catch {
    res.json({ success: true }); // Ignore if not running
  }
});

app.post('/api/graphiti/validate-falkordb', (req, res) => {
  const { uri } = req.body;
  // Basic validation - check if URI format is correct
  const isValid = uri && (uri.startsWith('redis://') || uri.startsWith('bolt://'));
  res.json({
    success: true,
    data: {
      valid: isValid,
      message: isValid ? 'URI format is valid' : 'Invalid URI format'
    }
  });
});

app.post('/api/graphiti/validate-openai', (req, res) => {
  const { key } = req.body;
  // Basic validation - check if key looks like an OpenAI key
  const isValid = key && key.startsWith('sk-');
  res.json({
    success: true,
    data: {
      valid: isValid,
      message: isValid ? 'Key format is valid' : 'Invalid API key format'
    }
  });
});

app.post('/api/graphiti/test', (req, res) => {
  const { falkorDbUri, openAiApiKey } = req.body;
  // Test connection - in web mode this is limited
  res.json({
    success: true,
    data: {
      connected: false,
      message: 'Connection testing requires backend service'
    }
  });
});

// ============ Other Missing Endpoints ============

app.post('/api/autobuild/source/download', (_req, res) => {
  res.json({
    success: false,
    error: 'Source download not supported in web mode. Please clone the repository manually.'
  });
});

app.post('/api/changelog/load-specs', (req, res) => {
  const { projectId } = req.query;
  const { taskIds } = req.body;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const specs: unknown[] = [];
  for (const taskId of taskIds || []) {
    const specPath = path.join(project.path, '.auto-claude', 'specs', taskId, 'spec.md');
    if (existsSync(specPath)) {
      specs.push({
        id: taskId,
        content: readFileSync(specPath, 'utf-8')
      });
    }
  }

  res.json({ success: true, data: specs });
});

app.post('/api/git/init', (req, res) => {
  const { path: projectPath } = req.query;
  if (!projectPath || !existsSync(String(projectPath))) {
    return res.json({ success: false, error: 'Path not found' });
  }

  const { execSync } = require('child_process');
  try {
    execSync('git init', { cwd: String(projectPath), encoding: 'utf-8' });
    res.json({ success: true, data: { initialized: true } });
  } catch (error) {
    res.json({ success: false, error: String(error) });
  }
});

app.post('/api/env/claude-setup', (req, res) => {
  const { projectId } = req.query;
  res.json({
    success: false,
    error: 'Claude setup requires running "claude login" in a terminal'
  });
});

// ============ WebSocket ============

wss.on('connection', (ws) => {
  console.log('[WebServer] Client connected');
  wsClients.add(ws);

  ws.on('close', () => {
    console.log('[WebServer] Client disconnected');
    wsClients.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('[WebServer] WebSocket error:', error);
    wsClients.delete(ws);
  });
});

// SPA fallback (Express 5 syntax)
// Note: web build produces index.web.html, not index.html
const indexFile = existsSync(path.join(staticPath, 'index.web.html'))
  ? 'index.web.html'
  : existsSync(path.join(staticPath, 'index.html'))
    ? 'index.html'
    : null;

app.use((_req, res) => {
  if (indexFile) {
    res.sendFile(path.join(staticPath, indexFile));
  } else {
    res.status(404).send('Build the frontend first: npm run web:build');
  }
});

// Start server
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                  Auto-Claude Web Server                    ║
╠═══════════════════════════════════════════════════════════╣
║  HTTP:      http://0.0.0.0:${PORT}                           ║
║  WebSocket: ws://0.0.0.0:${PORT}/ws                          ║
╚═══════════════════════════════════════════════════════════╝
`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[WebServer] Shutting down...');

  // Kill all terminals
  terminals.forEach((t) => t.pty.kill());
  terminals.clear();

  // Kill all running tasks
  runningTasks.forEach((t) => t.process.kill());
  runningTasks.clear();

  server.close(() => process.exit(0));
});
