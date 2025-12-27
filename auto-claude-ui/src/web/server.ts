/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-nocheck - Web server with intentional type flexibility for stub implementations
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
import { spawn, ChildProcess, exec } from 'child_process';
import { promisify } from 'util';
import * as pty from '@lydell/node-pty';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync, rmdirSync } from 'fs';
import Redis from 'ioredis';

const execAsync = promisify(exec);

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

// Log watching for real-time updates
interface LogWatcher {
  specId: string;
  projectPath: string;
  lastContent: string;
  lastWorktreeContent: string;
  interval: NodeJS.Timeout;
}
const logWatchers = new Map<string, LogWatcher>();

// ============ FalkorDB / Graphiti Integration ============
const FALKORDB_CONTAINER_NAME = 'auto-claude-falkordb';
const FALKORDB_IMAGE = 'falkordb/falkordb:latest';
const FALKORDB_DEFAULT_PORT = 6380;

interface FalkorDBStatus {
  available: boolean;
  enabled: boolean;
  host: string;
  port: number;
  database: string;
  reason?: string;
  containerRunning?: boolean;
}

let falkordbRedis: Redis | null = null;
let falkordbStatus: FalkorDBStatus = {
  available: false,
  enabled: false,
  host: 'localhost',
  port: FALKORDB_DEFAULT_PORT,
  database: 'auto_claude_memory',
  reason: 'Not initialized',
};

async function checkDockerAvailable(): Promise<boolean> {
  try {
    await execAsync('docker info', { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function checkFalkorDBContainer(): Promise<{ exists: boolean; running: boolean; port: number }> {
  try {
    const { stdout } = await execAsync(
      `docker ps -a --filter "name=${FALKORDB_CONTAINER_NAME}" --format "{{.Status}}"`,
      { timeout: 5000 }
    );
    const status = stdout.trim();
    if (!status) {
      return { exists: false, running: false, port: FALKORDB_DEFAULT_PORT };
    }

    const running = status.toLowerCase().startsWith('up');

    // Get port mapping
    let port = FALKORDB_DEFAULT_PORT;
    if (running) {
      try {
        const { stdout: portOut } = await execAsync(
          `docker port ${FALKORDB_CONTAINER_NAME} 6379`,
          { timeout: 5000 }
        );
        const match = portOut.match(/:(\d+)/);
        if (match) port = parseInt(match[1], 10);
      } catch {}
    }

    return { exists: true, running, port };
  } catch {
    return { exists: false, running: false, port: FALKORDB_DEFAULT_PORT };
  }
}

async function startFalkorDBContainer(): Promise<boolean> {
  try {
    const containerStatus = await checkFalkorDBContainer();

    if (containerStatus.running) {
      console.log('[FalkorDB] Container already running');
      return true;
    }

    if (containerStatus.exists) {
      console.log('[FalkorDB] Starting existing container...');
      await execAsync(`docker start ${FALKORDB_CONTAINER_NAME}`, { timeout: 30000 });
    } else {
      console.log('[FalkorDB] Creating and starting new container...');
      await execAsync(
        `docker run -d --name ${FALKORDB_CONTAINER_NAME} -p ${FALKORDB_DEFAULT_PORT}:6379 ${FALKORDB_IMAGE}`,
        { timeout: 60000 }
      );
    }

    // Wait for container to be ready
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const { stdout } = await execAsync(
          `docker exec ${FALKORDB_CONTAINER_NAME} redis-cli PING`,
          { timeout: 5000 }
        );
        if (stdout.trim().toUpperCase() === 'PONG') {
          console.log('[FalkorDB] Container ready');
          return true;
        }
      } catch {}
    }
    return false;
  } catch (error) {
    console.error('[FalkorDB] Failed to start container:', error);
    return false;
  }
}

async function connectToFalkorDB(): Promise<boolean> {
  try {
    if (falkordbRedis) {
      await falkordbRedis.quit();
      falkordbRedis = null;
    }

    const containerStatus = await checkFalkorDBContainer();
    if (!containerStatus.running) {
      return false;
    }

    falkordbRedis = new Redis({
      host: 'localhost',
      port: containerStatus.port,
      lazyConnect: true,
      connectTimeout: 5000,
      maxRetriesPerRequest: 1,
    });

    await falkordbRedis.connect();
    await falkordbRedis.ping();

    falkordbStatus = {
      available: true,
      enabled: true,
      host: 'localhost',
      port: containerStatus.port,
      database: 'auto_claude_memory',
      containerRunning: true,
    };

    console.log(`[FalkorDB] Connected on port ${containerStatus.port}`);
    return true;
  } catch (error) {
    console.error('[FalkorDB] Connection failed:', error);
    falkordbStatus = {
      available: false,
      enabled: false,
      host: 'localhost',
      port: FALKORDB_DEFAULT_PORT,
      database: 'auto_claude_memory',
      reason: error instanceof Error ? error.message : 'Connection failed',
    };
    return false;
  }
}

async function initializeFalkorDB(): Promise<void> {
  console.log('[FalkorDB] Initializing...');

  const dockerAvailable = await checkDockerAvailable();
  if (!dockerAvailable) {
    console.log('[FalkorDB] Docker not available');
    falkordbStatus = {
      available: false,
      enabled: false,
      host: 'localhost',
      port: FALKORDB_DEFAULT_PORT,
      database: 'auto_claude_memory',
      reason: 'Docker is not installed or not running',
    };
    return;
  }

  const containerStatus = await checkFalkorDBContainer();

  if (!containerStatus.running) {
    console.log('[FalkorDB] Container not running, attempting to start...');
    const started = await startFalkorDBContainer();
    if (!started) {
      falkordbStatus = {
        available: false,
        enabled: false,
        host: 'localhost',
        port: FALKORDB_DEFAULT_PORT,
        database: 'auto_claude_memory',
        reason: 'Failed to start FalkorDB container',
      };
      return;
    }
  }

  await connectToFalkorDB();
}

async function queryFalkorDB(graphName: string, query: string): Promise<unknown[]> {
  if (!falkordbRedis) {
    throw new Error('FalkorDB not connected');
  }
  return (await falkordbRedis.call('GRAPH.QUERY', graphName, query)) as unknown[];
}

async function listFalkorDBGraphs(): Promise<string[]> {
  if (!falkordbRedis) {
    return [];
  }
  try {
    return (await falkordbRedis.call('GRAPH.LIST')) as string[];
  } catch {
    return [];
  }
}

interface MemoryEpisode {
  id: string;
  type: string;
  timestamp: string;
  content: string;
  session_number?: number;
  score?: number;
}

function parseGraphResult(result: unknown[]): Record<string, unknown>[] {
  if (!Array.isArray(result) || result.length < 2) return [];
  const headers = result[0] as string[];
  const rows = result[1] as unknown[][];
  if (!Array.isArray(headers) || !Array.isArray(rows)) return [];
  return rows.map(row => {
    const obj: Record<string, unknown> = {};
    headers.forEach((header, idx) => { obj[header] = row[idx]; });
    return obj;
  });
}

async function getFalkorDBMemories(limit: number = 20): Promise<MemoryEpisode[]> {
  if (!falkordbRedis || !falkordbStatus.available) {
    console.log('[Memory] FalkorDB not available, skipping graph query');
    return [];
  }

  const graphs = await listFalkorDBGraphs();
  console.log(`[Memory] Found ${graphs.length} graphs in FalkorDB:`, graphs);

  const memories: MemoryEpisode[] = [];

  // Filter to spec-related graphs
  const specGraphs = graphs.filter(g =>
    !g.startsWith('project_') && g !== 'auto_build_memory' && g !== 'default_db'
  );
  console.log(`[Memory] Querying ${specGraphs.length} spec graphs:`, specGraphs);

  for (const graph of specGraphs) {
    try {
      const query = `
        MATCH (e:Episodic)
        RETURN e.uuid as uuid, e.name as name, e.created_at as created_at,
               e.content as content, e.source_description as description
        ORDER BY e.created_at DESC
        LIMIT ${Math.ceil(limit / Math.max(specGraphs.length, 1))}
      `;
      const result = await queryFalkorDB(graph, query);
      const episodes = parseGraphResult(result);
      console.log(`[Memory] Graph "${graph}": found ${episodes.length} episodic memories`);

      for (const ep of episodes) {
        memories.push({
          id: `${graph}:${ep.uuid || ep.name}`,
          type: inferEpisodeType(String(ep.name || ''), String(ep.content || '')),
          timestamp: String(ep.created_at || new Date().toISOString()),
          content: String(ep.content || ep.description || ep.name || ''),
          session_number: extractSessionNumber(String(ep.name || '')),
        });
      }
    } catch (err) {
      console.error(`[Memory] Failed to get memories from ${graph}:`, err);
    }
  }

  memories.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  console.log(`[Memory] Total memories retrieved: ${memories.length}`);
  return memories.slice(0, limit);
}

async function searchFalkorDBMemories(query: string, limit: number = 20): Promise<MemoryEpisode[]> {
  if (!falkordbRedis || !falkordbStatus.available) return [];

  const graphs = await listFalkorDBGraphs();
  const results: MemoryEpisode[] = [];
  const queryLower = query.toLowerCase().replace(/'/g, "\\'");

  const specGraphs = graphs.filter(g =>
    !g.startsWith('project_') && g !== 'auto_build_memory' && g !== 'default_db'
  );

  for (const graph of specGraphs) {
    try {
      const cypher = `
        MATCH (e:Episodic)
        WHERE toLower(e.name) CONTAINS '${queryLower}' OR toLower(e.content) CONTAINS '${queryLower}'
        RETURN e.uuid as uuid, e.name as name, e.created_at as created_at,
               e.content as content, e.source_description as description
        LIMIT ${Math.ceil(limit / Math.max(specGraphs.length, 1))}
      `;
      const result = await queryFalkorDB(graph, cypher);
      const episodes = parseGraphResult(result);

      for (const ep of episodes) {
        results.push({
          id: `${graph}:${ep.uuid || ep.name}`,
          type: inferEpisodeType(String(ep.name || ''), String(ep.content || '')),
          timestamp: String(ep.created_at || new Date().toISOString()),
          content: String(ep.content || ep.description || ep.name || ''),
          score: 1.0,
        });
      }
    } catch (err) {
      console.error(`Failed to search memories in ${graph}:`, err);
    }
  }

  return results.slice(0, limit);
}

function inferEpisodeType(name: string, content: string): string {
  const nameLower = name.toLowerCase();
  const contentLower = content.toLowerCase();
  if (nameLower.includes('session_') || contentLower.includes('"type": "session_insight"')) return 'session_insight';
  if (nameLower.includes('pattern') || contentLower.includes('"type": "pattern"')) return 'pattern';
  if (nameLower.includes('gotcha') || contentLower.includes('"type": "gotcha"')) return 'gotcha';
  if (nameLower.includes('codebase') || contentLower.includes('"type": "codebase_discovery"')) return 'codebase_discovery';
  return 'session_insight';
}

function extractSessionNumber(name: string): number | undefined {
  const match = name.match(/session_(\d+)/i);
  return match ? parseInt(match[1], 10) : undefined;
}

function loadFileBasedMemories(projectPath: string, limit: number): MemoryEpisode[] {
  const memories: MemoryEpisode[] = [];
  const specsDir = path.join(projectPath, '.auto-claude', 'specs');

  console.log(`[Memory] Loading file-based memories from: ${specsDir}`);

  if (!existsSync(specsDir)) {
    console.log('[Memory] Specs directory does not exist');
    return memories;
  }

  try {
    // Get ALL spec directories
    const allSpecDirs = readdirSync(specsDir)
      .filter(f => statSync(path.join(specsDir, f)).isDirectory());

    console.log(`[Memory] Found ${allSpecDirs.length} total spec directories`);

    // Filter to specs that HAVE memory directories (completed sessions)
    const specsWithMemory = allSpecDirs.filter(specDir => {
      const memoryDir = path.join(specsDir, specDir, 'memory');
      const hasMemory = existsSync(memoryDir);
      return hasMemory;
    });

    console.log(`[Memory] Specs with memory directories: ${specsWithMemory.length}`, specsWithMemory.slice(0, 10));

    // Sort by spec number (descending) and take top 10 specs with memories
    const specDirs = specsWithMemory.sort().reverse().slice(0, 10);

    for (const specDir of specDirs) {
      const memoryDir = path.join(specsDir, specDir, 'memory');
      console.log(`[Memory] Loading from: ${memoryDir}`);

      // Load session insights
      const sessionInsightsDir = path.join(memoryDir, 'session_insights');
      console.log(`[Memory] Checking session_insights dir: ${sessionInsightsDir}, exists: ${existsSync(sessionInsightsDir)}`);
      if (existsSync(sessionInsightsDir)) {
        const sessionFiles = readdirSync(sessionInsightsDir)
          .filter(f => f.startsWith('session_') && f.endsWith('.json'))
          .sort().reverse();
        console.log(`[Memory] Found ${sessionFiles.length} session files in ${specDir}`);

        for (const sessionFile of sessionFiles.slice(0, 3)) {
          try {
            const sessionPath = path.join(sessionInsightsDir, sessionFile);
            const sessionData = JSON.parse(readFileSync(sessionPath, 'utf-8'));
            if (sessionData.session_number !== undefined) {
              memories.push({
                id: `${specDir}-${sessionFile}`,
                type: 'session_insight',
                timestamp: sessionData.timestamp || new Date().toISOString(),
                content: JSON.stringify({
                  discoveries: sessionData.discoveries,
                  what_worked: sessionData.what_worked,
                  what_failed: sessionData.what_failed,
                  recommendations: sessionData.recommendations_for_next_session,
                  subtasks_completed: sessionData.subtasks_completed
                }, null, 2),
                session_number: sessionData.session_number
              });
            }
          } catch { /* skip */ }
        }
      }

      // Load codebase map
      const codebaseMapPath = path.join(memoryDir, 'codebase_map.json');
      if (existsSync(codebaseMapPath)) {
        try {
          const mapData = JSON.parse(readFileSync(codebaseMapPath, 'utf-8'));
          if (mapData.discovered_files && Object.keys(mapData.discovered_files).length > 0) {
            memories.push({
              id: `${specDir}-codebase_map`,
              type: 'codebase_map',
              timestamp: mapData.last_updated || new Date().toISOString(),
              content: JSON.stringify(mapData.discovered_files, null, 2),
            });
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }

  return memories.slice(0, limit);
}

function startLogWatching(specId: string, projectPath: string): void {
  // Stop existing watcher if any
  stopLogWatching(specId);

  const specDir = path.join(projectPath, '.auto-claude', 'specs', specId);
  const worktreeSpecDir = path.join(projectPath, '.worktrees', specId, '.auto-claude', 'specs', specId);

  let lastContent = '';
  let lastWorktreeContent = '';
  let lastPlanStatus = '';

  // Load initial content
  const mainLogFile = path.join(specDir, 'task_logs.json');
  const worktreeLogFile = path.join(worktreeSpecDir, 'task_logs.json');
  const mainPlanFile = path.join(specDir, 'implementation_plan.json');
  const worktreePlanFile = path.join(worktreeSpecDir, 'implementation_plan.json');

  if (existsSync(mainLogFile)) {
    try {
      lastContent = readFileSync(mainLogFile, 'utf-8');
    } catch {}
  }
  if (existsSync(worktreeLogFile)) {
    try {
      lastWorktreeContent = readFileSync(worktreeLogFile, 'utf-8');
    } catch {}
  }

  // Load initial plan status
  const planFile = existsSync(worktreePlanFile) ? worktreePlanFile : mainPlanFile;
  if (existsSync(planFile)) {
    try {
      const plan = JSON.parse(readFileSync(planFile, 'utf-8'));
      lastPlanStatus = plan.status || '';
    } catch {}
  }

  // Poll for changes every second
  const interval = setInterval(() => {
    let changed = false;
    let newLogs: unknown = null;

    // Check main spec dir
    if (existsSync(mainLogFile)) {
      try {
        const content = readFileSync(mainLogFile, 'utf-8');
        if (content !== lastContent) {
          lastContent = content;
          changed = true;
          newLogs = JSON.parse(content);
        }
      } catch {}
    }

    // Check worktree spec dir
    if (existsSync(worktreeLogFile)) {
      try {
        const content = readFileSync(worktreeLogFile, 'utf-8');
        if (content !== lastWorktreeContent) {
          lastWorktreeContent = content;
          changed = true;
          newLogs = JSON.parse(content);
        }
      } catch {}
    }

    if (changed && newLogs) {
      broadcast('task:logsChanged', { specId, logs: newLogs });
    }

    // Check for plan status changes (ai_review, human_review, etc.)
    const currentPlanFile = existsSync(worktreePlanFile) ? worktreePlanFile : mainPlanFile;
    if (existsSync(currentPlanFile)) {
      try {
        const plan = JSON.parse(readFileSync(currentPlanFile, 'utf-8'));
        const currentStatus = plan.status || '';
        if (currentStatus && currentStatus !== lastPlanStatus) {
          console.log(`[LogWatcher] Status changed for ${specId}: ${lastPlanStatus} -> ${currentStatus}`);
          lastPlanStatus = currentStatus;
          broadcast('task:statusChange', { taskId: specId, status: currentStatus });
        }
      } catch {}
    }
  }, 1000);

  logWatchers.set(specId, {
    specId,
    projectPath,
    lastContent,
    lastWorktreeContent,
    interval
  });
}

function stopLogWatching(specId: string): void {
  const watcher = logWatchers.get(specId);
  if (watcher) {
    clearInterval(watcher.interval);
    logWatchers.delete(specId);
  }
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

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
      let reviewReason: string | undefined;
      if (existsSync(planPath)) {
        try {
          const plan = JSON.parse(readFileSync(planPath, 'utf-8'));

          // Extract subtasks from phases (like Electron app does)
          // Handle both 'subtasks' and 'chunks' naming conventions
          if (plan.phases && Array.isArray(plan.phases)) {
            subtasks = plan.phases.flatMap((phase: { subtasks?: Array<{ id: string; description: string; status: string }>; chunks?: Array<{ id: string; description: string; status: string }> }) => {
              const items = phase.subtasks || phase.chunks || [];
              return items.map((subtask) => ({
                id: subtask.id,
                title: subtask.description,
                description: subtask.description,
                status: subtask.status || 'pending',
                files: []
              }));
            });
          }

          // Calculate status based on subtask progress (like Electron app)
          const allSubtasks = subtasks as Array<{ status: string }>;
          if (allSubtasks.length > 0) {
            const completed = allSubtasks.filter((s) => s.status === 'completed').length;
            const inProgress = allSubtasks.filter((s) => s.status === 'in_progress').length;
            const failed = allSubtasks.filter((s) => s.status === 'failed').length;

            if (completed === allSubtasks.length) {
              // All subtasks completed - check QA status
              const qaSignoff = plan.qa_signoff as { status?: string } | undefined;
              if (qaSignoff?.status === 'approved') {
                status = 'human_review';
                reviewReason = 'completed';
              } else {
                status = 'ai_review';
              }
            } else if (failed > 0) {
              status = 'human_review';
              reviewReason = 'errors';
            } else if (inProgress > 0 || completed > 0) {
              status = 'in_progress';
            }
          }

          // Check QA report for status
          const qaReportPath = path.join(specsDir, specName, 'qa_report.md');
          if (existsSync(qaReportPath)) {
            const qaContent = readFileSync(qaReportPath, 'utf-8');
            if (qaContent.includes('REJECTED') || qaContent.includes('FAILED')) {
              status = 'human_review';
              reviewReason = 'qa_rejected';
            } else if (qaContent.includes('PASSED') || qaContent.includes('APPROVED')) {
              if (allSubtasks.length > 0 && allSubtasks.every((s) => s.status === 'completed')) {
                status = 'human_review';
                reviewReason = 'completed';
              }
            }
          }

          // Respect explicit plan status for 'done'
          if (plan.status === 'done' || plan.status === 'completed') {
            status = 'done';
          } else if (plan.status === 'planning' || plan.status === 'coding') {
            status = 'in_progress';
          } else if (plan.status === 'human_review') {
            status = 'human_review';
          } else if (plan.status === 'ai_review') {
            status = 'ai_review';
          }

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

      // Override status if task is currently running in memory
      const effectiveStatus = runningTasks.has(specName) ? 'in_progress' : status;

      tasks.push({
        id: specName,
        specId: specName,
        projectId: projectId,
        title,
        description,
        status: effectiveStatus,
        reviewReason,
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

// Submit task review (approve or reject with feedback)
app.post('/api/tasks/:id/review', (req, res) => {
  const taskId = req.params.id;
  const { projectId, approved, feedback } = req.body;

  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const specDir = path.join(project.path, '.auto-claude', 'specs', taskId);
  const worktreePath = path.join(project.path, '.worktrees', taskId);
  const worktreeSpecDir = path.join(worktreePath, '.auto-claude', 'specs', taskId);
  const hasWorktree = existsSync(worktreePath);

  if (approved) {
    // Write approval to QA report
    const qaReportPath = path.join(specDir, 'qa_report.md');
    writeFileSync(
      qaReportPath,
      `# QA Review\n\nStatus: APPROVED\n\nReviewed at: ${new Date().toISOString()}\n`
    );

    // Update plan status to done
    const planPath = path.join(specDir, 'implementation_plan.json');
    if (existsSync(planPath)) {
      try {
        const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
        plan.status = 'human_review';
        plan.qa_signoff = { status: 'approved', timestamp: new Date().toISOString() };
        writeFileSync(planPath, JSON.stringify(plan, null, 2));
      } catch {}
    }

    broadcast('task:statusChange', { taskId, status: 'human_review' });
    res.json({ success: true });
  } else {
    // Write feedback for QA fixer - write to WORKTREE spec dir if it exists
    const targetSpecDir = hasWorktree ? worktreeSpecDir : specDir;
    const fixRequestPath = path.join(targetSpecDir, 'QA_FIX_REQUEST.md');

    console.log('[Review] Writing QA fix request to:', fixRequestPath);
    writeFileSync(
      fixRequestPath,
      `# QA Fix Request\n\nStatus: REJECTED\n\n## Feedback\n\n${feedback || 'No feedback provided'}\n\nCreated at: ${new Date().toISOString()}\n`
    );

    // Also write to main spec dir for visibility
    if (hasWorktree) {
      const mainFixRequestPath = path.join(specDir, 'QA_FIX_REQUEST.md');
      writeFileSync(mainFixRequestPath, readFileSync(fixRequestPath, 'utf-8'));
    }

    // Update plan status back to in_progress
    const planPath = path.join(hasWorktree ? worktreeSpecDir : specDir, 'implementation_plan.json');
    if (existsSync(planPath)) {
      try {
        const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
        plan.status = 'in_progress';
        plan.qa_signoff = { status: 'rejected', feedback, timestamp: new Date().toISOString() };
        writeFileSync(planPath, JSON.stringify(plan, null, 2));
      } catch {}
    }

    // Restart the task - use --qa for complete builds, --auto-continue for incomplete
    const autoBuildPath = getAutoBuildPath();
    if (autoBuildPath) {
      const pythonPath = path.join(autoBuildPath, '.venv', 'bin', 'python');
      const runScript = path.join(autoBuildPath, 'run.py');

      // Kill existing task if running
      if (runningTasks.has(taskId)) {
        runningTasks.get(taskId)?.process.kill();
        runningTasks.delete(taskId);
      }

      // Check if build is complete by counting subtasks
      let buildComplete = false;
      const planCheckPath = path.join(hasWorktree ? worktreeSpecDir : specDir, 'implementation_plan.json');
      if (existsSync(planCheckPath)) {
        try {
          const planCheck = JSON.parse(readFileSync(planCheckPath, 'utf-8'));
          const allSubtasks = (planCheck.phases || []).flatMap((p: { subtasks?: Array<{ status: string }>; chunks?: Array<{ status: string }> }) =>
            p.subtasks || p.chunks || []
          );
          const completedCount = allSubtasks.filter((s: { status: string }) => s.status === 'completed').length;
          buildComplete = allSubtasks.length > 0 && completedCount === allSubtasks.length;
          console.log(`[Review] Build progress: ${completedCount}/${allSubtasks.length}, complete: ${buildComplete}`);

          // Reset in_progress subtasks to pending so they get picked up
          let modified = false;
          for (const phase of planCheck.phases || []) {
            const items = phase.subtasks || phase.chunks || [];
            for (const item of items) {
              if (item.status === 'in_progress') {
                item.status = 'pending';
                modified = true;
              }
            }
          }
          if (modified) {
            writeFileSync(planCheckPath, JSON.stringify(planCheck, null, 2));
            console.log('[Review] Reset in_progress subtasks to pending');
          }
        } catch {}
      }

      // Use --qa for complete builds (runs QA fixer), --auto-continue for incomplete (resumes coding)
      const args = buildComplete
        ? [runScript, '--spec', taskId, '--qa', '--auto-continue']
        : [runScript, '--spec', taskId, '--auto-continue', '--force'];
      console.log('[Review] Starting task with feedback:', { pythonPath, args, cwd: project.path, buildComplete });

      const child = spawn(pythonPath, args, {
        cwd: project.path,
        env: { ...process.env, PYTHONUNBUFFERED: '1' }
      });

      runningTasks.set(taskId, {
        taskId,
        process: child,
        projectPath: project.path
      });

      startLogWatching(taskId, project.path);
      broadcast('task:statusChange', { taskId, status: 'in_progress' });

      child.stdout?.on('data', (data) => {
        const log = data.toString();
        console.log('[QA stdout]', taskId, log.substring(0, 200));
        broadcast('task:log', { taskId, log });
      });

      child.stderr?.on('data', (data) => {
        const log = data.toString();
        console.log('[QA stderr]', taskId, log.substring(0, 200));
        broadcast('task:log', { taskId, log });
      });

      child.on('exit', (code) => {
        console.log('[QA exit]', taskId, 'code:', code);
        runningTasks.delete(taskId);
        stopLogWatching(taskId);
        broadcast('task:exit', { taskId, code });

        // Always go back to human_review so user can retry or merge
        // Don't leave in in_progress which causes "stuck" state
        const finalStatus = 'human_review';

        // Update plan status
        const exitPlanPath = path.join(hasWorktree ? worktreeSpecDir : specDir, 'implementation_plan.json');
        if (existsSync(exitPlanPath)) {
          try {
            const exitPlan = JSON.parse(readFileSync(exitPlanPath, 'utf-8'));
            exitPlan.status = finalStatus;
            writeFileSync(exitPlanPath, JSON.stringify(exitPlan, null, 2));
          } catch {}
        }

        broadcast('task:statusChange', { taskId, status: finalStatus });
      });
    }

    res.json({ success: true });
  }
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

// List worktrees - matches Electron's TASK_LIST_WORKTREES
app.get('/api/worktrees', (req, res) => {
  const { projectId } = req.query;

  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const { execSync } = require('child_process');
  const worktreesDir = path.join(project.path, '.worktrees');

  interface WorktreeInfo {
    specName: string;
    path: string;
    branch: string;
    baseBranch: string;
    commitCount: number;
    filesChanged: number;
    additions: number;
    deletions: number;
  }
  const worktrees: WorktreeInfo[] = [];

  if (!existsSync(worktreesDir)) {
    return res.json({ success: true, data: { worktrees } });
  }

  // Get base branch from main project
  let baseBranch = 'main';
  try {
    baseBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: project.path,
      encoding: 'utf-8'
    }).trim();
  } catch {
    baseBranch = 'main';
  }

  const dirs = readdirSync(worktreesDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('worker-'))
    .map(d => d.name);

  for (const dir of dirs) {
    const entryPath = path.join(worktreesDir, dir);

    try {
      // Get branch info
      const branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: entryPath,
        encoding: 'utf-8'
      }).trim();

      // Get commit count
      let commitCount = 0;
      try {
        const countOutput = execSync(`git rev-list --count ${baseBranch}..HEAD 2>/dev/null || echo 0`, {
          cwd: entryPath,
          encoding: 'utf-8'
        }).trim();
        commitCount = parseInt(countOutput, 10) || 0;
      } catch {
        commitCount = 0;
      }

      // Get diff stats
      let filesChanged = 0;
      let additions = 0;
      let deletions = 0;

      try {
        const diffStat = execSync(`git diff --shortstat ${baseBranch}...HEAD 2>/dev/null || echo ""`, {
          cwd: entryPath,
          encoding: 'utf-8'
        }).trim();

        const filesMatch = diffStat.match(/(\d+) files? changed/);
        const addMatch = diffStat.match(/(\d+) insertions?/);
        const delMatch = diffStat.match(/(\d+) deletions?/);

        if (filesMatch) filesChanged = parseInt(filesMatch[1], 10) || 0;
        if (addMatch) additions = parseInt(addMatch[1], 10) || 0;
        if (delMatch) deletions = parseInt(delMatch[1], 10) || 0;
      } catch {
        // Ignore diff errors
      }

      worktrees.push({
        specName: dir,
        path: entryPath,
        branch,
        baseBranch,
        commitCount,
        filesChanged,
        additions,
        deletions
      });
    } catch (gitError) {
      console.error(`Error getting info for worktree ${dir}:`, gitError);
      // Skip this worktree if we can't get git info
    }
  }

  res.json({ success: true, data: { worktrees } });
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
  // Accept force at top level or in options
  if (options?.force || req.body.force) {
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

  // Detect current branch to use as parent branch for merge
  let parentBranch = '';
  try {
    const { execSync } = require('child_process');
    parentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: project.path,
      encoding: 'utf-8'
    }).trim();
    console.log('[Task Start] Parent branch detected:', parentBranch);
  } catch (err) {
    console.error('[Task Start] Failed to detect parent branch:', err);
  }

  // Update implementation_plan.json status to 'in_progress' (persist to disk like Electron)
  const planPath = path.join(project.path, '.auto-claude', 'specs', taskId, 'implementation_plan.json');
  if (existsSync(planPath)) {
    try {
      const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
      plan.status = 'in_progress';
      plan.planStatus = 'in_progress';
      plan.updated_at = new Date().toISOString();
      // Store parent branch for merge target (only if not already set)
      if (!plan.parent_branch && parentBranch) {
        plan.parent_branch = parentBranch;
        console.log('[Task Start] Stored parent_branch:', parentBranch);
      }
      writeFileSync(planPath, JSON.stringify(plan, null, 2));
      console.log('[Task Start] Updated implementation_plan.json status to in_progress');
    } catch (err) {
      console.error('[Task Start] Failed to update implementation_plan.json:', err);
    }
  }

  // Broadcast status change to 'in_progress' when task starts
  broadcast('task:statusChange', { taskId, status: 'in_progress' });

  // Start watching logs for real-time updates
  startLogWatching(taskId, project.path);

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
    stopLogWatching(taskId);
    broadcast('task:exit', { taskId, code });

    // Determine final status based on exit code
    const finalStatus = code === 0 ? 'human_review' : 'backlog';

    // Update implementation_plan.json status (persist to disk like Electron)
    const exitPlanPath = path.join(project.path, '.auto-claude', 'specs', taskId, 'implementation_plan.json');
    if (existsSync(exitPlanPath)) {
      try {
        const exitPlan = JSON.parse(readFileSync(exitPlanPath, 'utf-8'));
        exitPlan.status = finalStatus;
        exitPlan.planStatus = finalStatus === 'human_review' ? 'review' : 'pending';
        exitPlan.updated_at = new Date().toISOString();
        writeFileSync(exitPlanPath, JSON.stringify(exitPlan, null, 2));
        console.log('[Task exit] Updated implementation_plan.json status to', finalStatus);
      } catch (err) {
        console.error('[Task exit] Failed to update implementation_plan.json:', err);
      }
    }

    // Broadcast status change when task completes
    broadcast('task:statusChange', { taskId, status: finalStatus });
  });

  res.json({ success: true });
});

app.post('/api/tasks/:id/stop', (req, res) => {
  const taskId = req.params.id;
  const task = runningTasks.get(taskId);

  if (task) {
    task.process.kill();
    runningTasks.delete(taskId);
    stopLogWatching(taskId);
    // Broadcast status change when task is stopped
    broadcast('task:statusChange', { taskId, status: 'stopped' });
  }

  res.json({ success: true });
});

// Log watching endpoints
app.post('/api/tasks/:id/logs/watch', (req, res) => {
  const { projectId } = req.body;
  const taskId = req.params.id;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  startLogWatching(taskId, project.path);
  res.json({ success: true });
});

app.post('/api/tasks/:id/logs/unwatch', (req, res) => {
  const taskId = req.params.id;
  stopLogWatching(taskId);
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
  const autoBuildPath = getAutoBuildPath();
  console.log('[Roadmap] autoBuildPath:', autoBuildPath);
  if (!autoBuildPath) {
    console.error('[Roadmap] ERROR: getAutoBuildPath() returned null');
    broadcast('roadmap:error', { projectId, error: 'Auto-Claude not installed' });
    return res.json({ success: true, data: { started: false } });
  }
  const pythonPath = path.join(autoBuildPath, '.venv/bin/python');
  const roadmapScript = path.join(autoBuildPath, 'runners', 'roadmap_runner.py');

  console.log('[Roadmap] pythonPath:', pythonPath, 'exists:', existsSync(pythonPath));
  console.log('[Roadmap] roadmapScript:', roadmapScript, 'exists:', existsSync(roadmapScript));

  if (!existsSync(pythonPath) || !existsSync(roadmapScript)) {
    console.error('[Roadmap] ERROR: Python or script not found');
    console.error('[Roadmap] pythonPath exists:', existsSync(pythonPath));
    console.error('[Roadmap] roadmapScript exists:', existsSync(roadmapScript));
    broadcast('roadmap:error', { projectId, error: `Auto-Claude not installed or roadmap script not found. pythonPath=${pythonPath} (${existsSync(pythonPath)}), script=${roadmapScript} (${existsSync(roadmapScript)})` });
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
      console.log(`[Roadmap stdout] ${projectId}:`, output.substring(0, 200));
      // Try to parse progress updates
      const lines = output.split('\n').filter((l: string) => l.trim());
      for (const line of lines) {
        if (line.startsWith('{')) {
          try {
            const status = JSON.parse(line);
            broadcast('roadmap:progress', { projectId, status });
          } catch {
            // Not valid JSON, broadcast as message
            broadcast('roadmap:progress', { projectId, status: { message: line } });
          }
        } else if (line.trim()) {
          // Non-JSON output - broadcast as progress message
          broadcast('roadmap:progress', { projectId, status: { message: line } });
        }
      }
    });

    child.stderr?.on('data', (data) => {
      const errOutput = data.toString();
      console.error(`[Roadmap stderr] ${projectId}:`, errOutput);
      broadcast('roadmap:progress', { projectId, status: { error: errOutput } });
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

    // Check if feature was already converted - return existing spec info
    if (feature.linked_spec_id) {
      const existingSpecDir = path.join(project.path, '.auto-claude', 'specs', feature.linked_spec_id);
      if (existsSync(existingSpecDir)) {
        return res.json({
          success: true,
          data: {
            id: feature.linked_spec_id,
            specId: feature.linked_spec_id,
            projectId: projectId as string,
            title: feature.title,
            description: feature.description,
            status: 'backlog',
            alreadyExists: true
          }
        });
      }
      // If spec dir doesn't exist, clear the linked_spec_id and proceed with new conversion
      feature.linked_spec_id = undefined;
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

  const { execSync } = require('child_process');
  const worktreePath = path.join(project.path, '.worktrees', req.params.id);

  if (!existsSync(worktreePath)) {
    return res.json({ success: true, data: { exists: false } });
  }

  try {
    // Get current branch in worktree
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: worktreePath,
      encoding: 'utf-8'
    }).trim();

    // Get base branch from implementation_plan.json (parent_branch) or fallback to current branch
    let baseBranch = 'main';
    const planPath = path.join(project.path, '.auto-claude', 'specs', req.params.id, 'implementation_plan.json');
    if (existsSync(planPath)) {
      try {
        const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
        if (plan.parent_branch) {
          baseBranch = plan.parent_branch;
        }
      } catch {}
    }
    // Fallback to current branch in main project if no parent_branch
    if (baseBranch === 'main') {
      try {
        baseBranch = execSync('git rev-parse --abbrev-ref HEAD', {
          cwd: project.path,
          encoding: 'utf-8'
        }).trim();
      } catch {
        baseBranch = 'main';
      }
    }

    // Get commit count
    let commitCount = 0;
    try {
      const countOutput = execSync(`git rev-list --count ${baseBranch}..HEAD 2>/dev/null || echo 0`, {
        cwd: worktreePath,
        encoding: 'utf-8'
      }).trim();
      commitCount = parseInt(countOutput, 10) || 0;
    } catch {
      commitCount = 0;
    }

    // Get diff stats
    let filesChanged = 0;
    let additions = 0;
    let deletions = 0;

    try {
      const diffStat = execSync(`git diff --stat ${baseBranch}...HEAD 2>/dev/null || echo ""`, {
        cwd: worktreePath,
        encoding: 'utf-8'
      }).trim();

      // Parse the summary line (e.g., "3 files changed, 50 insertions(+), 10 deletions(-)")
      const summaryMatch = diffStat.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
      if (summaryMatch) {
        filesChanged = parseInt(summaryMatch[1], 10) || 0;
        additions = parseInt(summaryMatch[2], 10) || 0;
        deletions = parseInt(summaryMatch[3], 10) || 0;
      }
    } catch {
      // Ignore diff errors
    }

    res.json({
      success: true,
      data: {
        exists: true,
        worktreePath,
        branch,
        baseBranch,
        commitCount,
        filesChanged,
        additions,
        deletions
      }
    });
  } catch (gitError) {
    console.error('Git error getting worktree status:', gitError);
    res.json({ success: true, data: { exists: true, worktreePath } });
  }
});

app.get('/api/tasks/:id/worktree/diff', (req, res) => {
  const { projectId } = req.query;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const { execSync } = require('child_process');
  const worktreePath = path.join(project.path, '.worktrees', req.params.id);

  if (!existsSync(worktreePath)) {
    return res.json({ success: false, error: 'No worktree found for this task' });
  }

  // Get base branch from implementation_plan.json (parent_branch) or fallback to current branch
  let baseBranch = 'main';
  const planPath = path.join(project.path, '.auto-claude', 'specs', req.params.id, 'implementation_plan.json');
  if (existsSync(planPath)) {
    try {
      const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
      if (plan.parent_branch) {
        baseBranch = plan.parent_branch;
      }
    } catch {}
  }
  // Fallback to current branch in main project if no parent_branch
  if (baseBranch === 'main') {
    try {
      baseBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: project.path,
        encoding: 'utf-8'
      }).trim();
    } catch {
      baseBranch = 'main';
    }
  }

  try {
    // Get list of changed files
    const filesListOutput = execSync(`git diff --name-only ${baseBranch}...HEAD`, {
      cwd: worktreePath,
      encoding: 'utf-8'
    }).trim();

    const filesList = filesListOutput ? filesListOutput.split('\n') : [];

    // Get diff with stats for each file
    const diffOutput = execSync(`git diff --stat ${baseBranch}...HEAD`, {
      cwd: worktreePath,
      encoding: 'utf-8'
    });

    // Parse file stats from diff output
    interface DiffFile {
      path: string;
      status: string;
      additions: number;
      deletions: number;
    }
    const files: DiffFile[] = [];

    for (const filePath of filesList) {
      if (!filePath) continue;

      // Get file status (added, modified, deleted)
      let status = 'modified';
      try {
        const statusOutput = execSync(`git diff --name-status ${baseBranch}...HEAD -- "${filePath}"`, {
          cwd: worktreePath,
          encoding: 'utf-8'
        }).trim();
        if (statusOutput.startsWith('A')) status = 'added';
        else if (statusOutput.startsWith('D')) status = 'deleted';
        else if (statusOutput.startsWith('R')) status = 'renamed';
      } catch {}

      // Get additions/deletions for this file
      let additions = 0;
      let deletions = 0;
      try {
        const numstatOutput = execSync(`git diff --numstat ${baseBranch}...HEAD -- "${filePath}"`, {
          cwd: worktreePath,
          encoding: 'utf-8'
        }).trim();
        const numstatMatch = numstatOutput.match(/^(\d+|-)\s+(\d+|-)/);
        if (numstatMatch) {
          additions = numstatMatch[1] === '-' ? 0 : parseInt(numstatMatch[1], 10);
          deletions = numstatMatch[2] === '-' ? 0 : parseInt(numstatMatch[2], 10);
        }
      } catch {}

      files.push({
        path: filePath,
        status,
        additions,
        deletions
      });
    }

    res.json({
      success: true,
      data: {
        diff: diffOutput,
        files,
        totalFiles: files.length,
        totalAdditions: files.reduce((sum, f) => sum + f.additions, 0),
        totalDeletions: files.reduce((sum, f) => sum + f.deletions, 0)
      }
    });
  } catch (error) {
    console.error('Failed to get worktree diff:', error);
    res.json({ success: true, data: { diff: '', files: [] } });
  }
});

app.post('/api/tasks/:id/worktree/merge', (req, res) => {
  const { projectId, targetBranch } = req.body;
  const taskId = req.params.id;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const { execSync } = require('child_process');
  let hasStash = false; // Declare at top of handler scope to avoid ReferenceError in catch block
  try {
    const branchName = `auto-claude/${taskId}`;

    // Use targetBranch if provided, otherwise read parent_branch from plan, fallback to main/master
    let baseBranch = targetBranch;
    if (!baseBranch) {
      // Try to read parent_branch from implementation_plan.json
      const planPath = path.join(project.path, '.auto-claude', 'specs', taskId, 'implementation_plan.json');
      if (existsSync(planPath)) {
        try {
          const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
          if (plan.parent_branch) {
            baseBranch = plan.parent_branch;
            console.log('[Merge] Using parent_branch from plan:', baseBranch);
          }
        } catch {}
      }
      // Fallback to main/master if no parent_branch stored
      if (!baseBranch) {
        try {
          execSync('git rev-parse --verify main', { cwd: project.path, encoding: 'utf-8', stdio: 'pipe' });
          baseBranch = 'main';
        } catch {
          baseBranch = 'master';
        }
      }
    }

    // Checkout target branch if different from current
    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: project.path,
      encoding: 'utf-8'
    }).trim();

    if (currentBranch !== baseBranch) {
      console.log(`[Merge] Checking out target branch: ${baseBranch}`);
      execSync(`git checkout ${baseBranch}`, { cwd: project.path, encoding: 'utf-8', stdio: 'pipe' });
    }

    // Check if branch is already merged
    let alreadyMerged = false;
    try {
      const unmergedCommits = execSync(`git log ${baseBranch}..${branchName} --oneline`, {
        cwd: project.path,
        encoding: 'utf-8',
        stdio: 'pipe'
      }).trim();
      alreadyMerged = unmergedCommits === '';
    } catch {
      // Branch might not exist, continue with merge attempt
    }

    if (alreadyMerged) {
      console.log(`[Merge] Branch ${branchName} already merged`);
      // Update task status to done even if already merged
      const planPath = path.join(project.path, '.auto-claude', 'specs', taskId, 'implementation_plan.json');
      if (existsSync(planPath)) {
        try {
          const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
          plan.status = 'done';
          plan.merged_at = plan.merged_at || new Date().toISOString();
          writeFileSync(planPath, JSON.stringify(plan, null, 2));
        } catch {}
      }
      return res.json({
        success: true,
        data: {
          success: true,
          message: 'Branch already merged'
        }
      });
    }

    // Abort any ongoing merge first
    try {
      execSync('git merge --abort', { cwd: project.path, encoding: 'utf-8', stdio: 'pipe' });
      console.log('[Merge] Aborted previous merge');
    } catch {
      // No merge in progress, continue
    }

    // Check for uncommitted changes and stash them (excluding worktrees)
    try {
      // Exclude .worktrees from status check - they're git worktrees, not regular files
      const status = execSync('git status --porcelain -- . ":(exclude).worktrees"', { cwd: project.path, encoding: 'utf-8' });
      const hasChanges = status.trim().length > 0;
      if (hasChanges) {
        console.log('[Merge] Stashing uncommitted changes');
        execSync('git stash push -m "Pre-merge stash" -- . ":(exclude).worktrees"', { cwd: project.path, encoding: 'utf-8', stdio: 'pipe' });
        hasStash = true;
      }
    } catch (e) {
      console.log('[Merge] Stash failed, continuing:', e);
    }

    // Ensure .worktrees is in .gitignore to prevent future issues
    const gitignorePath = path.join(project.path, '.gitignore');
    try {
      const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : '';
      if (!gitignore.includes('.worktrees')) {
        writeFileSync(gitignorePath, gitignore + '\n.worktrees/\n');
        console.log('[Merge] Added .worktrees to .gitignore');
      }
    } catch {}

    // Clean up untracked files that might conflict
    const filesToClean = ['.claude_settings.json', '.auto-claude-status'];
    for (const file of filesToClean) {
      const filePath = path.join(project.path, file);
      if (existsSync(filePath)) {
        try {
          unlinkSync(filePath);
          console.log(`[Merge] Cleaned up ${file}`);
        } catch {}
      }
    }

    // Remove local spec dir if it exists and is untracked (will be replaced by merge)
    const localSpecDir = path.join(project.path, '.auto-claude', 'specs', taskId);
    try {
      const isTracked = execSync(`git ls-files --error-unmatch "${localSpecDir}" 2>/dev/null || echo "untracked"`,
        { cwd: project.path, encoding: 'utf-8' }).trim();
      if (isTracked === 'untracked' && existsSync(localSpecDir)) {
        console.log('[Merge] Removing untracked local spec dir:', localSpecDir);
        const { rmSync } = require('fs');
        rmSync(localSpecDir, { recursive: true, force: true });
      }
    } catch {}

    // Perform the merge
    try {
      execSync(`git merge ${branchName} --no-edit`, { cwd: project.path, encoding: 'utf-8' });
    } catch (mergeError) {
      // Check if it's a conflict on status files that we can auto-resolve
      const status = execSync('git status --porcelain', { cwd: project.path, encoding: 'utf-8' });
      const mergeErrorMessage = mergeError instanceof Error ? mergeError.message : String(mergeError);

      // Match different conflict types: UU (both modified), DU (deleted by us), UD (deleted by them)
      const conflictLines = status.split('\n').filter(line => /^(UU|DU|UD|AA) /.test(line));
      const conflictFiles = conflictLines.map(line => line.slice(3).trim());

      // Check for submodule conflicts
      const hasSubmoduleConflict = mergeErrorMessage.includes('submodule') || mergeErrorMessage.includes('CONFLICT (submodule)');

      const autoResolvableFiles = ['.auto-claude-status', '.claude_settings.json'];
      // Also auto-resolve submodule conflicts by accepting the current (main branch) version
      const canAutoResolve = conflictFiles.length > 0 && conflictFiles.every(f => autoResolvableFiles.includes(f));

      if (canAutoResolve || hasSubmoduleConflict) {
        console.log('[Merge] Auto-resolving conflicts on:', conflictFiles);

        // First resolve regular file conflicts
        for (const line of conflictLines) {
          const conflictType = line.slice(0, 2);
          const file = line.slice(3).trim();
          try {
            if (conflictType === 'DU') {
              // Deleted in HEAD, modified in theirs - remove the file
              execSync(`git rm "${file}"`, { cwd: project.path, encoding: 'utf-8', stdio: 'pipe' });
            } else if (conflictType === 'UD') {
              // Modified in HEAD, deleted in theirs - keep deleted
              execSync(`git rm "${file}"`, { cwd: project.path, encoding: 'utf-8', stdio: 'pipe' });
            } else {
              // UU or AA - accept theirs
              execSync(`git checkout --theirs "${file}"`, { cwd: project.path, encoding: 'utf-8', stdio: 'pipe' });
              execSync(`git add "${file}"`, { cwd: project.path, encoding: 'utf-8', stdio: 'pipe' });
            }
          } catch {}
        }

        // Handle submodule conflicts - keep HEAD version (main branch's submodule state)
        if (hasSubmoduleConflict) {
          console.log('[Merge] Resolving submodule conflicts by keeping current version');
          try {
            // Get list of submodules and reset them to HEAD
            const submodules = execSync('git config --file .gitmodules --get-regexp path | cut -d" " -f2', {
              cwd: project.path, encoding: 'utf-8', stdio: 'pipe'
            }).trim().split('\n').filter(Boolean);

            for (const submodule of submodules) {
              try {
                // Checkout the HEAD version of the submodule reference
                execSync(`git checkout HEAD -- "${submodule}"`, { cwd: project.path, encoding: 'utf-8', stdio: 'pipe' });
                execSync(`git add "${submodule}"`, { cwd: project.path, encoding: 'utf-8', stdio: 'pipe' });
              } catch {}
            }
          } catch {
            // If submodule handling fails, just try to add all and continue
            try {
              execSync('git add -A', { cwd: project.path, encoding: 'utf-8', stdio: 'pipe' });
            } catch {}
          }
        }

        try {
          execSync(`git commit -m "Merge ${branchName}"`, { cwd: project.path, encoding: 'utf-8' });
        } catch {
          // If commit fails, there may still be conflicts - continue without commit
          console.log('[Merge] Auto-commit failed, attempting to continue');
        }
      } else if (conflictFiles.length === 0) {
        // No conflicts but merge failed - might be an untracked file issue, try to continue
        try {
          execSync('git merge --continue', { cwd: project.path, encoding: 'utf-8', stdio: 'pipe' });
        } catch {
          throw mergeError;
        }
      } else {
        throw mergeError;
      }
    }

    // Pop stash if we created one
    if (hasStash) {
      try {
        console.log('[Merge] Restoring stashed changes');
        execSync('git stash pop', { cwd: project.path, encoding: 'utf-8', stdio: 'pipe' });
      } catch (e) {
        console.log('[Merge] Stash pop failed (may have conflicts):', e);
        // Try to drop the stash if pop failed - changes might already be in merge
        try {
          execSync('git stash drop', { cwd: project.path, encoding: 'utf-8', stdio: 'pipe' });
        } catch {}
      }
    }

    // Update task status to done
    const planPath = path.join(project.path, '.auto-claude', 'specs', taskId, 'implementation_plan.json');
    if (existsSync(planPath)) {
      try {
        const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
        plan.status = 'done';
        plan.merged_at = new Date().toISOString();
        writeFileSync(planPath, JSON.stringify(plan, null, 2));
      } catch {}
    }

    res.json({
      success: true,
      data: {
        success: true,
        message: 'Merge completed successfully'
      }
    });
  } catch (error) {
    console.error('[Merge] Error:', error);
    // Restore stash even on error
    if (hasStash) {
      try {
        execSync('git stash pop', { cwd: project.path, encoding: 'utf-8', stdio: 'pipe' });
      } catch {}
    }
    res.json({
      success: false,
      error: error instanceof Error ? error.message : String(error)
    });
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
  const taskId = req.params.id;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const { execSync } = require('child_process');
  try {
    const branchName = `auto-claude/${taskId}`;
    const worktreePath = path.join(project.path, '.worktrees', taskId);

    // Detect base branch (main or master)
    let baseBranch = 'main';
    try {
      execSync('git rev-parse --verify main', { cwd: project.path, encoding: 'utf-8', stdio: 'pipe' });
    } catch {
      baseBranch = 'master';
    }

    // Get commits
    let commits: string[] = [];
    try {
      const commitOutput = execSync(`git log ${baseBranch}..${branchName} --oneline`, { cwd: project.path, encoding: 'utf-8' });
      commits = commitOutput.trim().split('\n').filter(Boolean);
    } catch {
      // Branch might not exist yet
    }

    // Get changed files
    let files: string[] = [];
    try {
      const diffOutput = execSync(`git diff --name-only ${baseBranch}..${branchName}`, { cwd: project.path, encoding: 'utf-8' });
      files = diffOutput.trim().split('\n').filter(Boolean);
    } catch {
      // Try getting files from worktree
      try {
        const statusOutput = execSync('git diff --name-only HEAD', { cwd: worktreePath, encoding: 'utf-8' });
        files = statusOutput.trim().split('\n').filter(Boolean);
      } catch {}
    }

    // Return proper preview format
    res.json({
      success: true,
      data: {
        success: true,
        message: `${commits.length} commits, ${files.length} files to merge`,
        preview: {
          files: files,
          conflicts: [], // No conflict detection in web mode - just merge directly
          summary: {
            totalFiles: files.length,
            conflictFiles: 0,
            totalConflicts: 0,
            autoMergeable: 0
          }
        },
        commits: commits
      }
    });
  } catch (error) {
    console.error('[Merge Preview] Error:', error);
    res.json({
      success: true,
      data: {
        success: true,
        message: 'Ready to merge',
        preview: {
          files: [],
          conflicts: [],
          summary: {
            totalFiles: 0,
            conflictFiles: 0,
            totalConflicts: 0,
            autoMergeable: 0
          }
        },
        commits: []
      }
    });
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

  // Use the global FalkorDB status for memory status
  let memoryState = null;

  // Try to load memory state from file (fallback)
  const hasMemory = existsSync(memoryDir);
  if (hasMemory) {
    const stateFile = path.join(memoryDir, 'state.json');
    if (existsSync(stateFile)) {
      try {
        memoryState = JSON.parse(readFileSync(stateFile, 'utf-8'));
      } catch {}
    }
  }

  // Load recent memories from specs (same logic as /api/context/memories)
  const recentMemories = loadFileBasedMemories(project.path, 5);

  res.json({
    success: true,
    data: {
      projectIndex,
      memoryStatus: falkordbStatus, // Use real FalkorDB status
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

  // Return the live FalkorDB status from the global state
  res.json({
    success: true,
    data: falkordbStatus
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
app.get('/api/context/memories/search', async (req, res) => {
  const { projectId, q } = req.query;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const queryStr = String(q || '');
  if (!queryStr.trim()) {
    return res.json({ success: true, data: [] });
  }

  // Try FalkorDB first if available
  if (falkordbStatus.available) {
    try {
      const falkorResults = await searchFalkorDBMemories(queryStr, 20);
      if (falkorResults.length > 0) {
        return res.json({
          success: true,
          data: falkorResults.map(r => ({
            content: r.content,
            score: r.score || 1.0,
            type: r.type
          }))
        });
      }
    } catch (err) {
      console.warn('FalkorDB search failed, falling back to file-based:', err);
    }
  }

  // Fall back to file-based search in specs directories
  const specsDir = path.join(project.path, '.auto-claude', 'specs');
  const results: Array<{ content: string; score: number; type: string }> = [];
  const queryLower = queryStr.toLowerCase();

  if (existsSync(specsDir)) {
    try {
      const specDirs = readdirSync(specsDir)
        .filter(f => statSync(path.join(specsDir, f)).isDirectory());

      for (const specDir of specDirs) {
        const memoryDir = path.join(specsDir, specDir, 'memory');
        if (!existsSync(memoryDir)) continue;

        const memoryFiles = readdirSync(memoryDir).filter(f => f.endsWith('.json'));
        for (const memFile of memoryFiles) {
          try {
            const memPath = path.join(memoryDir, memFile);
            const memContent = readFileSync(memPath, 'utf-8');
            if (memContent.toLowerCase().includes(queryLower)) {
              const memData = JSON.parse(memContent);
              results.push({
                content: JSON.stringify(memData.insights || memData, null, 2),
                score: 1.0,
                type: 'session_insight'
              });
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }
  }

  res.json({ success: true, data: results.slice(0, 20) });
});

// Get recent memories
app.get('/api/context/memories', async (req, res) => {
  const { projectId, limit } = req.query;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  console.log(`[Memory API] GET /memories - projectId: ${projectId}, limit: ${limit}`);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const memLimit = Number(limit) || 20;

  // Try FalkorDB first if available
  if (falkordbStatus.available) {
    console.log('[Memory API] Trying FalkorDB...');
    try {
      const falkorMemories = await getFalkorDBMemories(memLimit);
      console.log(`[Memory API] FalkorDB returned ${falkorMemories.length} memories`);
      if (falkorMemories.length > 0) {
        return res.json({ success: true, data: falkorMemories });
      }
    } catch (err) {
      console.warn('[Memory API] FalkorDB query failed, falling back to file-based:', err);
    }
  } else {
    console.log('[Memory API] FalkorDB not available, using file-based');
  }

  // Fall back to file-based memories from specs
  console.log(`[Memory API] Loading file-based memories from: ${project.path}`);
  const memories = loadFileBasedMemories(project.path, memLimit);
  console.log(`[Memory API] File-based returned ${memories.length} memories`);
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

// Convert idea to task
app.post('/api/ideation/ideas/:id/convert', (req, res) => {
  const ideaId = req.params.id;
  const { projectId } = req.query;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const ideationPath = path.join(project.path, '.auto-claude', 'ideation', 'ideation.json');
  if (!existsSync(ideationPath)) {
    return res.status(404).json({ success: false, error: 'Ideation not found' });
  }

  try {
    const ideation = JSON.parse(readFileSync(ideationPath, 'utf-8'));
    const idea = ideation.ideas?.find((i: { id: string }) => i.id === ideaId);

    if (!idea) {
      return res.status(404).json({ success: false, error: 'Idea not found' });
    }

    // Get specs directory
    const specsDir = path.join(project.path, '.auto-claude', 'specs');
    if (!existsSync(specsDir)) {
      mkdirSync(specsDir, { recursive: true });
    }

    // Find next spec number
    let nextNum = 1;
    try {
      const existingSpecs = readdirSync(specsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => {
          const match = d.name.match(/^(\d+)-/);
          return match ? parseInt(match[1], 10) : 0;
        })
        .filter(n => n > 0);
      if (existingSpecs.length > 0) {
        nextNum = Math.max(...existingSpecs) + 1;
      }
    } catch {}

    // Create spec ID
    const slug = idea.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50);
    const specId = `${String(nextNum).padStart(3, '0')}-${slug}`;
    const specDir = path.join(specsDir, specId);

    // Create spec directory
    mkdirSync(specDir, { recursive: true });

    // Build task description
    let description = `# ${idea.title}\n\n${idea.description}\n\n## Rationale\n${idea.rationale}\n\n`;
    if (idea.implementation_approach) {
      description += `## Implementation Approach\n${idea.implementation_approach}\n\n`;
    }
    if (idea.affected_files?.length) {
      description += `## Affected Files\n${idea.affected_files.map((f: string) => `- ${f}`).join('\n')}\n\n`;
    }

    // Map idea type to category
    const categoryMap: Record<string, string> = {
      'code_improvements': 'feature',
      'ui_ux_improvements': 'ui_ux',
      'documentation_gaps': 'documentation',
      'security_hardening': 'security',
      'performance_optimizations': 'performance',
      'code_quality': 'refactoring'
    };

    // Create implementation_plan.json
    const plan = {
      feature: idea.title,
      description: idea.description,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: 'backlog',
      planStatus: 'pending',
      phases: [],
      workflow_type: 'development',
      services_involved: [],
      final_acceptance: [],
      spec_file: 'spec.md'
    };
    writeFileSync(path.join(specDir, 'implementation_plan.json'), JSON.stringify(plan, null, 2));

    // Create spec.md
    const specContent = `# ${idea.title}

## Overview

${idea.description}

## Rationale

${idea.rationale}

---
*This spec was created from ideation and is pending detailed specification.*
`;
    writeFileSync(path.join(specDir, 'spec.md'), specContent);

    // Create metadata
    const metadata = {
      sourceType: 'ideation',
      ideationType: idea.type,
      ideaId: idea.id,
      rationale: idea.rationale,
      category: categoryMap[idea.type] || 'feature',
      affectedFiles: idea.affected_files || idea.affected_components || []
    };
    writeFileSync(path.join(specDir, 'task_metadata.json'), JSON.stringify(metadata, null, 2));

    // Update idea status to archived
    idea.status = 'archived';
    idea.linked_task_id = specId;
    ideation.updated_at = new Date().toISOString();
    writeFileSync(ideationPath, JSON.stringify(ideation, null, 2));

    // Build task response
    const task = {
      id: specId,
      specId: specId,
      projectId,
      title: idea.title,
      description: description,
      status: 'backlog',
      subtasks: [],
      logs: [],
      metadata,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    res.json({ success: true, data: task });
  } catch (error) {
    console.error('[Ideation Convert] Error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to convert idea to task'
    });
  }
});

// Update idea status
app.patch('/api/ideation/ideas/:id', (req, res) => {
  const ideaId = req.params.id;
  const { projectId } = req.query;
  const { status } = req.body;

  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const ideationPath = path.join(project.path, '.auto-claude', 'ideation', 'ideation.json');
  if (!existsSync(ideationPath)) {
    return res.status(404).json({ success: false, error: 'Ideation not found' });
  }

  try {
    const ideation = JSON.parse(readFileSync(ideationPath, 'utf-8'));
    const idea = ideation.ideas?.find((i: { id: string }) => i.id === ideaId);

    if (!idea) {
      return res.status(404).json({ success: false, error: 'Idea not found' });
    }

    idea.status = status;
    ideation.updated_at = new Date().toISOString();
    writeFileSync(ideationPath, JSON.stringify(ideation, null, 2));

    res.json({ success: true, data: idea });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to update idea' });
  }
});

// Dismiss idea
app.post('/api/ideation/ideas/:id/dismiss', (req, res) => {
  const ideaId = req.params.id;
  const { projectId } = req.query;

  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const ideationPath = path.join(project.path, '.auto-claude', 'ideation', 'ideation.json');
  if (!existsSync(ideationPath)) {
    return res.status(404).json({ success: false, error: 'Ideation not found' });
  }

  try {
    const ideation = JSON.parse(readFileSync(ideationPath, 'utf-8'));
    const idea = ideation.ideas?.find((i: { id: string }) => i.id === ideaId);

    if (!idea) {
      return res.status(404).json({ success: false, error: 'Idea not found' });
    }

    idea.status = 'dismissed';
    ideation.updated_at = new Date().toISOString();
    writeFileSync(ideationPath, JSON.stringify(ideation, null, 2));

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to dismiss idea' });
  }
});

// Archive idea
app.post('/api/ideation/ideas/:id/archive', (req, res) => {
  const ideaId = req.params.id;
  const { projectId } = req.query;

  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const ideationPath = path.join(project.path, '.auto-claude', 'ideation', 'ideation.json');
  if (!existsSync(ideationPath)) {
    return res.status(404).json({ success: false, error: 'Ideation not found' });
  }

  try {
    const ideation = JSON.parse(readFileSync(ideationPath, 'utf-8'));
    const idea = ideation.ideas?.find((i: { id: string }) => i.id === ideaId);

    if (!idea) {
      return res.status(404).json({ success: false, error: 'Idea not found' });
    }

    idea.status = 'archived';
    ideation.updated_at = new Date().toISOString();
    writeFileSync(ideationPath, JSON.stringify(ideation, null, 2));

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to archive idea' });
  }
});

// Delete idea
app.delete('/api/ideation/ideas/:id', (req, res) => {
  const ideaId = req.params.id;
  const { projectId } = req.query;

  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const ideationPath = path.join(project.path, '.auto-claude', 'ideation', 'ideation.json');
  if (!existsSync(ideationPath)) {
    return res.status(404).json({ success: false, error: 'Ideation not found' });
  }

  try {
    const ideation = JSON.parse(readFileSync(ideationPath, 'utf-8'));
    const ideaIndex = ideation.ideas?.findIndex((i: { id: string }) => i.id === ideaId);

    if (ideaIndex === -1 || ideaIndex === undefined) {
      return res.status(404).json({ success: false, error: 'Idea not found' });
    }

    ideation.ideas.splice(ideaIndex, 1);
    ideation.updated_at = new Date().toISOString();
    writeFileSync(ideationPath, JSON.stringify(ideation, null, 2));

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete idea' });
  }
});

// Dismiss all ideas
app.post('/api/ideation/dismiss-all', (req, res) => {
  const { projectId } = req.query;

  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const ideationPath = path.join(project.path, '.auto-claude', 'ideation', 'ideation.json');
  if (!existsSync(ideationPath)) {
    return res.status(404).json({ success: false, error: 'Ideation not found' });
  }

  try {
    const ideation = JSON.parse(readFileSync(ideationPath, 'utf-8'));
    if (ideation.ideas) {
      ideation.ideas.forEach((idea: { status: string }) => {
        idea.status = 'dismissed';
      });
    }
    ideation.updated_at = new Date().toISOString();
    writeFileSync(ideationPath, JSON.stringify(ideation, null, 2));

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to dismiss all ideas' });
  }
});

// Delete multiple ideas
app.post('/api/ideation/delete-multiple', (req, res) => {
  const { projectId } = req.query;
  const { ideaIds } = req.body;

  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const ideationPath = path.join(project.path, '.auto-claude', 'ideation', 'ideation.json');
  if (!existsSync(ideationPath)) {
    return res.status(404).json({ success: false, error: 'Ideation not found' });
  }

  try {
    const ideation = JSON.parse(readFileSync(ideationPath, 'utf-8'));
    if (ideation.ideas) {
      ideation.ideas = ideation.ideas.filter((i: { id: string }) => !ideaIds.includes(i.id));
    }
    ideation.updated_at = new Date().toISOString();
    writeFileSync(ideationPath, JSON.stringify(ideation, null, 2));

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete ideas' });
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

// Support both GET (discovery) and POST (with tasks filter)
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

app.post('/api/changelog/done-tasks', (req, res) => {
  const { projectId } = req.query;
  const { tasks } = req.body;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  // If tasks provided in body, use those (frontend is sending filtered tasks)
  if (tasks && Array.isArray(tasks)) {
    // Filter to only include done tasks and format them
    const doneTasks = tasks.filter((t: { status?: string }) =>
      t.status === 'done' || t.status === 'completed' || t.status === 'human_review'
    ).map((t: { id?: string; title?: string; spec_id?: string }) => ({
      id: t.id || t.spec_id,
      title: t.title || t.id || t.spec_id
    }));
    return res.json({ success: true, data: doneTasks });
  }

  // Otherwise, discover from filesystem
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

  const specId = req.params.id;
  const specDir = path.join(project.path, '.auto-claude', 'specs', specId);
  const worktreeSpecDir = path.join(project.path, '.worktrees', specId, '.auto-claude', 'specs', specId);

  // Try to load structured task_logs.json (like Electron does)
  const loadTaskLogs = (dir: string) => {
    const logFile = path.join(dir, 'task_logs.json');
    if (existsSync(logFile)) {
      try {
        return JSON.parse(readFileSync(logFile, 'utf-8'));
      } catch {
        return null;
      }
    }
    return null;
  };

  const mainLogs = loadTaskLogs(specDir);
  const worktreeLogs = loadTaskLogs(worktreeSpecDir);

  // Merge logs from both locations (worktree takes precedence for coding/validation)
  let taskLogs = mainLogs;
  if (worktreeLogs) {
    if (!mainLogs) {
      taskLogs = worktreeLogs;
    } else {
      // Merge: planning from main, coding/validation from worktree if available
      taskLogs = {
        spec_id: mainLogs.spec_id,
        created_at: mainLogs.created_at,
        updated_at: worktreeLogs.updated_at > mainLogs.updated_at ? worktreeLogs.updated_at : mainLogs.updated_at,
        phases: {
          planning: mainLogs.phases?.planning || worktreeLogs.phases?.planning,
          coding: (worktreeLogs.phases?.coding?.entries?.length > 0 || worktreeLogs.phases?.coding?.status !== 'pending')
            ? worktreeLogs.phases.coding
            : mainLogs.phases?.coding,
          validation: (worktreeLogs.phases?.validation?.entries?.length > 0 || worktreeLogs.phases?.validation?.status !== 'pending')
            ? worktreeLogs.phases.validation
            : mainLogs.phases?.validation
        }
      };
    }
  }

  // Also load legacy .log files if no structured logs
  if (!taskLogs) {
    const logsPath = path.join(specDir, 'logs');
    const logs: string[] = [];
    if (existsSync(logsPath)) {
      const logFiles = readdirSync(logsPath).filter((f) => f.endsWith('.log'));
      for (const logFile of logFiles) {
        const content = readFileSync(path.join(logsPath, logFile), 'utf-8');
        logs.push(content);
      }
    }
    return res.json({ success: true, data: { raw: logs.join('\n') } });
  }

  res.json({ success: true, data: taskLogs });
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

// Changelog Git Operations
app.get('/api/changelog/branches', (req, res) => {
  const { projectId } = req.query;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const { execSync } = require('child_process');
  try {
    // Get current branch
    let currentBranch = '';
    try {
      currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: project.path,
        encoding: 'utf-8'
      }).trim();
    } catch {}

    // Get all branches
    const output = execSync('git branch -a --format="%(refname:short)|%(HEAD)"', {
      cwd: project.path,
      encoding: 'utf-8'
    });

    const branches: { name: string; isRemote: boolean; isCurrent: boolean }[] = [];
    const seenNames = new Set<string>();

    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [name, head] = trimmed.split('|');
      if (!name || name === 'HEAD' || name.includes('HEAD')) continue;

      const isRemote = name.startsWith('origin/') || name.startsWith('remotes/');
      const displayName = isRemote ? name.replace(/^origin\//, '') : name;
      if (seenNames.has(displayName) && isRemote) continue;
      seenNames.add(displayName);

      branches.push({
        name: displayName,
        isRemote,
        isCurrent: head === '*' || displayName === currentBranch
      });
    }

    // Sort: current first, then local, then remote
    branches.sort((a, b) => {
      if (a.isCurrent && !b.isCurrent) return -1;
      if (!a.isCurrent && b.isCurrent) return 1;
      if (!a.isRemote && b.isRemote) return -1;
      if (a.isRemote && !b.isRemote) return 1;
      return a.name.localeCompare(b.name);
    });

    res.json({ success: true, data: branches });
  } catch (error) {
    res.json({ success: false, error: String(error) });
  }
});

app.get('/api/changelog/tags', (req, res) => {
  const { projectId } = req.query;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const { execSync } = require('child_process');
  try {
    const output = execSync(
      'git tag -l --sort=-creatordate --format="%(refname:short)|%(creatordate:iso-strict)|%(objectname:short)"',
      { cwd: project.path, encoding: 'utf-8' }
    );

    const tags: { name: string; date?: string; commit?: string }[] = [];
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split('|');
      if (parts[0]) {
        tags.push({ name: parts[0], date: parts[1], commit: parts[2] });
      }
    }

    res.json({ success: true, data: tags });
  } catch (error) {
    res.json({ success: false, error: String(error) });
  }
});

app.post('/api/changelog/commits-preview', (req, res) => {
  const { projectId } = req.query;
  const { options, mode } = req.body;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const { execSync } = require('child_process');
  try {
    const format = '%h|%H|%s|%an|%ae|%aI';
    let command = `git log --pretty=format:"${format}"`;

    if (mode === 'git-history') {
      if (!options.includeMergeCommits) command += ' --no-merges';
      switch (options.type) {
        case 'recent':
          command += ` -n ${options.count || 25}`;
          break;
        case 'since-date':
          if (options.sinceDate) command += ` --since="${options.sinceDate}"`;
          break;
        case 'tag-range':
          if (options.fromTag) command += ` ${options.fromTag}..${options.toTag || 'HEAD'}`;
          break;
        case 'since-version':
          if (options.fromTag) command += ` ${options.fromTag}..HEAD`;
          break;
      }
    } else if (mode === 'branch-diff') {
      command += ` --no-merges ${options.baseBranch}..${options.compareBranch}`;
    }

    const output = execSync(command, {
      cwd: project.path,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024
    });

    const commits = output.split('\n').filter(Boolean).map((line: string) => {
      const parts = line.split('|');
      return {
        shortHash: parts[0],
        hash: parts[1],
        message: parts[2],
        author: parts[3],
        email: parts[4],
        date: parts[5]
      };
    });

    res.json({ success: true, data: commits });
  } catch (error) {
    res.json({ success: false, error: String(error) });
  }
});

app.post('/api/changelog/save', (req, res) => {
  const { projectId } = req.query;
  const { content, version, createGitTag, tagMessage } = req.body;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const { execSync } = require('child_process');
  try {
    // Write changelog file
    const changelogPath = path.join(project.path, 'CHANGELOG.md');
    writeFileSync(changelogPath, content);

    // Create git tag if requested
    if (createGitTag && version) {
      const tagName = version.startsWith('v') ? version : `v${version}`;
      const message = tagMessage || `Release ${tagName}`;
      execSync(`git tag -a "${tagName}" -m "${message}"`, {
        cwd: project.path,
        encoding: 'utf-8'
      });
    }

    res.json({
      success: true,
      data: {
        path: changelogPath,
        version,
        tagCreated: createGitTag && version
      }
    });
  } catch (error) {
    res.json({ success: false, error: String(error) });
  }
});

app.post('/api/changelog/suggest-version', (req, res) => {
  const { projectId } = req.query;
  const { taskIds } = req.body;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  // Get current version from existing changelog or tags
  const changelogPath = path.join(project.path, 'CHANGELOG.md');
  let currentVersion = '0.0.0';

  if (existsSync(changelogPath)) {
    const content = readFileSync(changelogPath, 'utf-8');
    const versionMatch = content.match(/##\s*\[?v?(\d+\.\d+\.\d+)/);
    if (versionMatch) currentVersion = versionMatch[1];
  }

  // Simple version bump based on number of tasks (heuristic)
  const [major, minor, patch] = currentVersion.split('.').map(Number);
  let suggestedVersion: string;
  let reason: string;

  if (taskIds && taskIds.length > 5) {
    suggestedVersion = `${major}.${minor + 1}.0`;
    reason = 'feature';
  } else {
    suggestedVersion = `${major}.${minor}.${patch + 1}`;
    reason = 'patch';
  }

  res.json({ success: true, data: { version: suggestedVersion, reason } });
});

app.post('/api/changelog/save-image', (req, res) => {
  const { projectId } = req.query;
  const { imageData, filename } = req.body;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  try {
    const assetsDir = path.join(project.path, '.github', 'assets');
    if (!existsSync(assetsDir)) {
      mkdirSync(assetsDir, { recursive: true });
    }

    const base64Data = imageData.includes(',') ? imageData.split(',')[1] : imageData;
    const buffer = Buffer.from(base64Data, 'base64');
    const imagePath = path.join(assetsDir, filename);
    writeFileSync(imagePath, buffer);

    const relativePath = `.github/assets/${filename}`;
    res.json({ success: true, data: { relativePath, url: relativePath } });
  } catch (error) {
    res.json({ success: false, error: String(error) });
  }
});

app.post('/api/changelog/generate', async (req, res) => {
  const { projectId } = req.query;
  const request = req.body;
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);

  if (!project) {
    return res.status(404).json({ success: false, error: 'Project not found' });
  }

  const { spawn, execSync } = require('child_process');

  // Find claude binary
  let claudePath = 'claude';
  try {
    claudePath = execSync('which claude', { encoding: 'utf-8' }).trim();
  } catch {
    // Try common paths
    const paths = ['/usr/local/bin/claude', '/usr/bin/claude', `${process.env.HOME}/.claude/bin/claude`];
    for (const p of paths) {
      if (existsSync(p)) { claudePath = p; break; }
    }
  }

  // Build prompt based on source mode
  let prompt = '';
  const version = request.version || '1.0.0';
  const date = request.date || new Date().toISOString().split('T')[0];
  const format = request.format || 'keep-a-changelog';
  const audience = request.audience || 'technical';

  const audienceInstructions: Record<string, string> = {
    'technical': 'You are a technical documentation specialist creating a changelog for developers. Use precise technical language.',
    'user-facing': 'You are a product manager writing release notes for end users. Use clear, non-technical language focusing on user benefits.',
    'marketing': 'You are a marketing specialist writing release notes. Focus on outcomes and user impact with compelling language.'
  };

  broadcast('changelog:generationProgress', { projectId, progress: { stage: 'preparing', progress: 10, message: 'Preparing prompt...' } });

  if (request.sourceMode === 'git-history' && request.gitHistory) {
    // Get commits from git
    const gitFormat = '%h|%H|%s|%an|%ae|%aI';
    let gitCommand = `git log --pretty=format:"${gitFormat}" --no-merges`;

    switch (request.gitHistory.type) {
      case 'recent':
        gitCommand += ` -n ${request.gitHistory.count || 25}`;
        break;
      case 'since-date':
        if (request.gitHistory.sinceDate) gitCommand += ` --since="${request.gitHistory.sinceDate}"`;
        break;
      case 'tag-range':
        if (request.gitHistory.fromTag) gitCommand += ` ${request.gitHistory.fromTag}..${request.gitHistory.toTag || 'HEAD'}`;
        break;
    }

    try {
      const output = execSync(gitCommand, { cwd: project.path, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
      const commits = output.split('\n').filter(Boolean).map((line: string) => {
        const parts = line.split('|');
        return { hash: parts[0], subject: parts[2], author: parts[3] };
      });

      const commitLines = commits.map((c: { hash: string; subject: string; author: string }) =>
        `- ${c.hash} | ${c.subject} | by ${c.author}`
      ).join('\n');

      prompt = `${audienceInstructions[audience]}

Generate a changelog in ${format} format for version ${version} (${date}).

Commits:
${commitLines}

CRITICAL: Output ONLY the raw changelog content. Start directly with the changelog heading.`;
    } catch (e) {
      return res.json({ success: false, error: `Failed to get commits: ${e}` });
    }
  } else if (request.taskIds && request.taskIds.length > 0) {
    // Load specs for tasks
    const taskSummaries: string[] = [];
    for (const taskId of request.taskIds) {
      const specPath = path.join(project.path, '.auto-claude', 'specs', taskId, 'spec.md');
      if (existsSync(specPath)) {
        const content = readFileSync(specPath, 'utf-8');
        const titleMatch = content.match(/^#\s+(.+)/m);
        taskSummaries.push(`- ${titleMatch ? titleMatch[1] : taskId}: ${content.slice(0, 300)}...`);
      }
    }

    prompt = `${audienceInstructions[audience]}

Generate a changelog in ${format} format for version ${version} (${date}).

Completed tasks:
${taskSummaries.join('\n')}

CRITICAL: Output ONLY the raw changelog content. Start directly with the changelog heading.`;
  } else {
    return res.json({ success: false, error: 'No source provided (commits or tasks)' });
  }

  broadcast('changelog:generationProgress', { projectId, progress: { stage: 'generating', progress: 30, message: 'Generating with Claude AI...' } });

  // Call Claude CLI
  const base64Prompt = Buffer.from(prompt, 'utf-8').toString('base64');
  const pythonScript = `
import subprocess
import sys
import base64

try:
    prompt = base64.b64decode('${base64Prompt}').decode('utf-8')
    result = subprocess.run(
        ['${claudePath}', '-p', prompt, '--output-format', 'text', '--model', 'haiku'],
        capture_output=True,
        text=True,
        stdin=subprocess.DEVNULL,
        timeout=300
    )
    if result.returncode == 0:
        print(result.stdout)
    else:
        print(f"Error: {result.stderr}", file=sys.stderr)
        sys.exit(1)
except Exception as e:
    print(f"Error: {e}", file=sys.stderr)
    sys.exit(1)
`;

  const pythonPath = existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3';
  const child = spawn(pythonPath, ['-c', pythonScript], { cwd: project.path });

  let output = '';
  let errorOutput = '';

  child.stdout?.on('data', (data: Buffer) => {
    output += data.toString();
    broadcast('changelog:generationProgress', { projectId, progress: { stage: 'generating', progress: 60, message: 'Receiving response...' } });
  });

  child.stderr?.on('data', (data: Buffer) => {
    errorOutput += data.toString();
  });

  child.on('exit', (code: number | null) => {
    if (code === 0 && output.trim()) {
      broadcast('changelog:generationProgress', { projectId, progress: { stage: 'complete', progress: 100, message: 'Complete' } });
      broadcast('changelog:generationComplete', { projectId, result: { changelog: output.trim(), version, date } });
      res.json({ success: true, data: { changelog: output.trim(), version, date } });
    } else {
      broadcast('changelog:generationError', { projectId, error: errorOutput || 'Generation failed' });
      res.json({ success: false, error: errorOutput || 'Generation failed' });
    }
  });

  child.on('error', (err: Error) => {
    broadcast('changelog:generationError', { projectId, error: err.message });
    res.json({ success: false, error: err.message });
  });
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
server.listen(PORT, async () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                  Auto-Claude Web Server                    ║
╠═══════════════════════════════════════════════════════════╣
║  HTTP:      http://0.0.0.0:${PORT}                           ║
║  WebSocket: ws://0.0.0.0:${PORT}/ws                          ║
╚═══════════════════════════════════════════════════════════╝
`);

  // Initialize FalkorDB (auto-starts container if Docker is available)
  await initializeFalkorDB();
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[WebServer] Shutting down...');

  // Kill all terminals
  terminals.forEach((t) => t.pty.kill());
  terminals.clear();

  // Kill all running tasks
  runningTasks.forEach((t) => t.process.kill());
  runningTasks.clear();

  // Close FalkorDB connection
  if (falkordbRedis) {
    await falkordbRedis.quit().catch(() => {});
    falkordbRedis = null;
  }

  server.close(() => process.exit(0));
});
