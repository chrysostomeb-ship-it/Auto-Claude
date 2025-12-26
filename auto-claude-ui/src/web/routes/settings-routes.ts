// @ts-nocheck
/**
 * Settings Routes - HTTP endpoints for app settings
 */

import { Router } from 'express';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import os from 'os';

const SETTINGS_DIR = path.join(os.homedir(), '.auto-claude');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');

function loadSettings(): Record<string, unknown> {
  try {
    if (existsSync(SETTINGS_FILE)) {
      return JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'));
    }
  } catch {
    // Ignore
  }
  return {};
}

function saveSettings(settings: Record<string, unknown>): void {
  if (!existsSync(SETTINGS_DIR)) {
    mkdirSync(SETTINGS_DIR, { recursive: true });
  }
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

export function createSettingsRoutes(): Router {
  const router = Router();

  // GET /api/settings - Get all settings
  router.get('/', (_req, res) => {
    try {
      const settings = loadSettings();
      res.json({ success: true, data: settings });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  // PUT /api/settings - Save settings
  router.put('/', (req, res) => {
    try {
      saveSettings(req.body);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  // PATCH /api/settings - Update partial settings
  router.patch('/', (req, res) => {
    try {
      const current = loadSettings();
      const updated = { ...current, ...req.body };
      saveSettings(updated);
      res.json({ success: true, data: updated });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  return router;
}
