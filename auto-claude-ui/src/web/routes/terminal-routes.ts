/**
 * Terminal Routes - HTTP/WebSocket endpoints for terminal management
 *
 * Terminals use WebSocket for real-time I/O
 */

import { Router } from 'express';
import * as pty from '@lydell/node-pty';
import * as os from 'os';

interface ManagedTerminal {
  id: string;
  pty: pty.IPty;
  cwd: string;
  buffer: string;
}

const terminals = new Map<string, ManagedTerminal>();

export function createTerminalRoutes(
  broadcast: (event: string, data: unknown) => void
): Router {
  const router = Router();

  // POST /api/terminal - Create a new terminal
  router.post('/', (req, res) => {
    try {
      const { cwd, cols = 120, rows = 30 } = req.body;
      const id = `term-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      const shell = process.platform === 'win32'
        ? process.env.COMSPEC || 'cmd.exe'
        : process.env.SHELL || '/bin/bash';

      const shellArgs = process.platform === 'win32' ? [] : ['-l'];

      const ptyProcess = pty.spawn(shell, shellArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: cwd || os.homedir(),
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor'
        }
      });

      const terminal: ManagedTerminal = {
        id,
        pty: ptyProcess,
        cwd: cwd || os.homedir(),
        buffer: ''
      };

      // Handle PTY output
      ptyProcess.onData((data) => {
        terminal.buffer = (terminal.buffer + data).slice(-100000);
        broadcast('terminal:output', { id, data });
      });

      // Handle PTY exit
      ptyProcess.onExit(({ exitCode }) => {
        broadcast('terminal:exit', { id, exitCode });
        terminals.delete(id);
      });

      terminals.set(id, terminal);

      res.json({ success: true, data: { id } });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  // GET /api/terminal - List terminals
  router.get('/', (_req, res) => {
    const list = Array.from(terminals.values()).map((t) => ({
      id: t.id,
      cwd: t.cwd
    }));
    res.json({ success: true, data: list });
  });

  // POST /api/terminal/:id/input - Send input to terminal
  router.post('/:id/input', (req, res) => {
    try {
      const terminal = terminals.get(req.params.id);
      if (!terminal) {
        return res.status(404).json({ success: false, error: 'Terminal not found' });
      }

      const { data } = req.body;
      terminal.pty.write(data);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  // POST /api/terminal/:id/resize - Resize terminal
  router.post('/:id/resize', (req, res) => {
    try {
      const terminal = terminals.get(req.params.id);
      if (!terminal) {
        return res.status(404).json({ success: false, error: 'Terminal not found' });
      }

      const { cols, rows } = req.body;
      terminal.pty.resize(cols, rows);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  // GET /api/terminal/:id/buffer - Get terminal buffer
  router.get('/:id/buffer', (req, res) => {
    try {
      const terminal = terminals.get(req.params.id);
      if (!terminal) {
        return res.status(404).json({ success: false, error: 'Terminal not found' });
      }

      res.json({ success: true, data: { buffer: terminal.buffer } });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  // DELETE /api/terminal/:id - Kill terminal
  router.delete('/:id', (req, res) => {
    try {
      const terminal = terminals.get(req.params.id);
      if (!terminal) {
        return res.status(404).json({ success: false, error: 'Terminal not found' });
      }

      terminal.pty.kill();
      terminals.delete(req.params.id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  return router;
}

// Cleanup all terminals on shutdown
export function cleanupTerminals(): void {
  terminals.forEach((terminal) => {
    try {
      terminal.pty.kill();
    } catch {
      // Ignore
    }
  });
  terminals.clear();
}
