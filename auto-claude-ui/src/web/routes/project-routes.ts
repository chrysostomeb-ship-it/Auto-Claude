/**
 * Project Routes - HTTP endpoints for project management
 */

import { Router } from 'express';
import type { ProjectStore } from '../../main/project-store';

export function createProjectRoutes(projectStore: ProjectStore): Router {
  const router = Router();

  // GET /api/projects - List all projects
  router.get('/', (_req, res) => {
    try {
      const projects = projectStore.getProjects();
      res.json({ success: true, data: projects });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  // POST /api/projects - Add a project
  router.post('/', (req, res) => {
    try {
      const { path: projectPath } = req.body;
      const project = projectStore.addProject(projectPath);
      res.json({ success: true, data: project });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  // DELETE /api/projects/:id - Remove a project
  router.delete('/:id', (req, res) => {
    try {
      projectStore.removeProject(req.params.id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  // PATCH /api/projects/:id/settings - Update project settings
  router.patch('/:id/settings', (req, res) => {
    try {
      projectStore.updateProjectSettings(req.params.id, req.body);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  // POST /api/projects/:id/initialize - Initialize auto-claude in project
  router.post('/:id/initialize', async (req, res) => {
    try {
      const result = await projectStore.initializeProject(req.params.id);
      res.json({ success: true, data: result });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  return router;
}
