// @ts-nocheck
/**
 * Task Routes - HTTP endpoints for task/spec management
 */

import { Router } from 'express';
import type { AgentManager } from '../../main/agent';
import type { ProjectStore } from '../../main/project-store';
import type { FileWatcher } from '../../main/file-watcher';

export function createTaskRoutes(
  agentManager: AgentManager,
  projectStore: ProjectStore,
  fileWatcher: FileWatcher,
  broadcast: (event: string, data: unknown) => void
): Router {
  const router = Router();

  // GET /api/tasks?projectId=xxx - List tasks for a project
  router.get('/', (req, res) => {
    try {
      const { projectId } = req.query;
      if (!projectId || typeof projectId !== 'string') {
        return res.status(400).json({ success: false, error: 'projectId required' });
      }
      const tasks = projectStore.getTasks(projectId);
      res.json({ success: true, data: tasks });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  // POST /api/tasks - Create a new task/spec
  router.post('/', async (req, res) => {
    try {
      const { projectId, title, description, complexity } = req.body;
      const project = projectStore.getProject(projectId);
      if (!project) {
        return res.status(404).json({ success: false, error: 'Project not found' });
      }

      // Start spec creation via agent manager
      const taskId = await agentManager.createSpec(project.path, {
        title,
        description,
        complexity
      });

      res.json({ success: true, data: { taskId } });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  // POST /api/tasks/:id/start - Start task execution
  router.post('/:id/start', async (req, res) => {
    try {
      const { projectId } = req.body;
      const project = projectStore.getProject(projectId);
      if (!project) {
        return res.status(404).json({ success: false, error: 'Project not found' });
      }

      agentManager.startTask(req.params.id, project.path);

      // Start watching for progress
      const specDir = projectStore.getSpecDir(projectId, req.params.id);
      if (specDir) {
        fileWatcher.watch(req.params.id, specDir);
      }

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  // POST /api/tasks/:id/stop - Stop task execution
  router.post('/:id/stop', (req, res) => {
    try {
      agentManager.stopTask(req.params.id);
      fileWatcher.unwatch(req.params.id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  // GET /api/tasks/:id/logs - Get task logs
  router.get('/:id/logs', (req, res) => {
    try {
      const { projectId } = req.query;
      if (!projectId || typeof projectId !== 'string') {
        return res.status(400).json({ success: false, error: 'projectId required' });
      }
      const logs = projectStore.getTaskLogs(projectId, req.params.id);
      res.json({ success: true, data: logs });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  // POST /api/tasks/:id/merge - Merge worktree into main
  router.post('/:id/merge', async (req, res) => {
    try {
      const { projectId } = req.body;
      const result = await projectStore.mergeWorktree(projectId, req.params.id);
      res.json({ success: true, data: result });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  // POST /api/tasks/:id/discard - Discard worktree
  router.post('/:id/discard', async (req, res) => {
    try {
      const { projectId } = req.body;
      await projectStore.discardWorktree(projectId, req.params.id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  // DELETE /api/tasks/:id - Delete a task
  router.delete('/:id', async (req, res) => {
    try {
      const { projectId } = req.query;
      if (!projectId || typeof projectId !== 'string') {
        return res.status(400).json({ success: false, error: 'projectId required' });
      }
      await projectStore.deleteTask(projectId, req.params.id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  return router;
}
