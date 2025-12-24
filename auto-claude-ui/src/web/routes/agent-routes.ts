/**
 * Agent Routes - HTTP endpoints for Claude profile management
 */

import { Router } from 'express';
import type { AgentManager } from '../../main/agent';
import type { PythonEnvManager } from '../../main/python-env-manager';
import { getClaudeProfileManager } from '../../main/claude-profile-manager';

export function createAgentRoutes(
  agentManager: AgentManager,
  pythonEnvManager: PythonEnvManager
): Router {
  const router = Router();

  // GET /api/agent/profiles - Get all Claude profiles
  router.get('/profiles', (_req, res) => {
    try {
      const profileManager = getClaudeProfileManager();
      const profiles = profileManager.getProfiles();
      const activeId = profileManager.getActiveProfileId();
      res.json({ success: true, data: { profiles, activeId } });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  // POST /api/agent/profiles/:id/activate - Set active profile
  router.post('/profiles/:id/activate', (req, res) => {
    try {
      const profileManager = getClaudeProfileManager();
      profileManager.setActiveProfile(req.params.id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  // GET /api/agent/profiles/auto-switch - Get auto-switch settings
  router.get('/profiles/auto-switch', (_req, res) => {
    try {
      const profileManager = getClaudeProfileManager();
      const settings = profileManager.getAutoSwitchSettings();
      res.json({ success: true, data: settings });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  // PUT /api/agent/profiles/auto-switch - Update auto-switch settings
  router.put('/profiles/auto-switch', (req, res) => {
    try {
      const profileManager = getClaudeProfileManager();
      profileManager.updateAutoSwitchSettings(req.body);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  // GET /api/agent/python - Get Python environment info
  router.get('/python', (_req, res) => {
    try {
      res.json({
        success: true,
        data: {
          pythonPath: pythonEnvManager.getPythonPath(),
          venvExists: pythonEnvManager.venvExists(),
          ready: pythonEnvManager.isReady()
        }
      });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  // GET /api/agent/status - Get running tasks status
  router.get('/status', (_req, res) => {
    try {
      const running = agentManager.getRunningTasks();
      res.json({ success: true, data: { running } });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  return router;
}
