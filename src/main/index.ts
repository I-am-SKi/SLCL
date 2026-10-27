import { app, BrowserWindow, shell } from 'electron';
import { join } from 'path';
import { registerIpc } from './ipc';
import { IPC } from '@shared/ipc';
import { getSettings } from './settings/store';

/** App icon: bundled into `resources/` at package time by electron-builder. */
function appIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(__dirname, '../../build/icon.png');
}

function createWindow(): void {
  // Match the window's pre-render background to the saved mode so a light-mode
  // start doesn't flash a dark rectangle.
  let backgroundColor = '#0e0f14';
  try {
    if (getSettings().colorMode === 'light') backgroundColor = '#f5f7fa';
  } catch {
    /* settings not ready - keep the dark default */
  }

  const win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    show: false,
    // No native title bar / caption icon: the renderer draws its own themed one.
    frame: false,
    // Keeps the resize borders + drop shadow for a frameless window on Windows.
    thickFrame: true,
    roundedCorners: true,
    autoHideMenuBar: true,
    backgroundColor,
    title: 'SLCL',
    icon: appIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.on('ready-to-show', () => win.show());

  // Tell the renderer when the maximize state changes so its title-bar button
  // can switch between "maximize" and "restore".
  const pushMaximized = (): void => {
    if (!win.isDestroyed()) win.webContents.send(IPC.eventWinMaximized, win.isMaximized());
  };
  win.on('maximize', pushMaximized);
  win.on('unmaximize', pushMaximized);

  // Open external links in the default browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('ready-to-show', () => win.show());

  // Open external links in the default browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
