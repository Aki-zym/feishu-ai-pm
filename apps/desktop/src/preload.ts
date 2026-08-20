import { contextBridge, ipcRenderer } from 'electron';
import type {
  DesktopConfigInput,
  DesktopRequest,
  DesktopResponse,
  ExternalLinkResultListener,
  OpenDocumentUrlInput,
  OpenExternalUrlResult,
  OpenTaskMemoryResult,
  PublicDesktopConfig,
} from './contracts.js';

const desktop = {
  api: {
    request: (request: DesktopRequest) => ipcRenderer.invoke('pm:request', request) as Promise<DesktopResponse>,
  },
  app: {
    info: () => ipcRenderer.invoke('app:info') as Promise<{ version: string; platform: string; packaged: boolean }>,
    relaunch: () => ipcRenderer.invoke('app:relaunch') as Promise<void>,
  },
  config: {
    get: () => ipcRenderer.invoke('config:get') as Promise<PublicDesktopConfig>,
    save: (input: DesktopConfigInput) => ipcRenderer.invoke('config:save', input) as Promise<PublicDesktopConfig>,
  },
  feishu: {
    authorize: () => ipcRenderer.invoke('feishu:authorize') as Promise<OpenExternalUrlResult>,
  },
  externalLinks: {
    open: (input: OpenDocumentUrlInput) => ipcRenderer.invoke('external-link:open', input) as Promise<OpenExternalUrlResult>,
    onResult: (listener: ExternalLinkResultListener) => {
      const handler = (_event: Electron.IpcRendererEvent, result: OpenExternalUrlResult) => listener(result);
      ipcRenderer.on('external-link:result', handler);
      return () => ipcRenderer.removeListener('external-link:result', handler);
    },
  },
  workspace: {
    pickDirectory: () => ipcRenderer.invoke('workspace:pick-directory') as Promise<string | null>,
  },
  taskMemory: {
    open: (taskId: string) => ipcRenderer.invoke('task-memory:open', taskId) as Promise<OpenTaskMemoryResult>,
  },
  diagnostics: {
    export: () => ipcRenderer.invoke('diagnostics:export') as Promise<{ saved: boolean; path?: string }>,
  },
};

contextBridge.exposeInMainWorld('aiPmDesktop', desktop);
