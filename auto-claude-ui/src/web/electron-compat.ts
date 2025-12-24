/**
 * Electron Compatibility Layer for Web Mode
 *
 * Provides stubs for Electron APIs when running in Node.js (web server mode)
 */

import os from 'os';
import path from 'path';

// Create a mock app object that mimics Electron's app API
const userData = path.join(os.homedir(), '.auto-claude');

export const app = {
  getPath: (name: string): string => {
    switch (name) {
      case 'userData':
        return userData;
      case 'home':
        return os.homedir();
      case 'temp':
        return os.tmpdir();
      case 'appData':
        return process.platform === 'win32'
          ? path.join(os.homedir(), 'AppData', 'Roaming')
          : path.join(os.homedir(), '.config');
      default:
        return userData;
    }
  },
  getAppPath: (): string => process.cwd(),
  getName: (): string => 'Auto-Claude',
  getVersion: (): string => require('../../package.json').version,
  isPackaged: false,
  name: 'Auto-Claude'
};

export const shell = {
  openExternal: async (url: string): Promise<void> => {
    console.log('[Web] Would open external URL:', url);
  },
  showItemInFolder: (fullPath: string): void => {
    console.log('[Web] Would show in folder:', fullPath);
  }
};

export const dialog = {
  showOpenDialog: async (): Promise<{ canceled: boolean; filePaths: string[] }> => {
    // In web mode, we can't show native dialogs
    // The client will need to handle this differently
    return { canceled: true, filePaths: [] };
  },
  showMessageBox: async (): Promise<{ response: number }> => {
    return { response: 0 };
  }
};

export const BrowserWindow = {
  getAllWindows: (): unknown[] => [],
  getFocusedWindow: (): null => null
};

export const nativeImage = {
  createFromPath: (): { isEmpty: () => boolean } => ({
    isEmpty: () => true
  })
};

// Export a combined electron module
export default {
  app,
  shell,
  dialog,
  BrowserWindow,
  nativeImage
};
