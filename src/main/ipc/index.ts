import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { IPC } from '@shared/ipc';
import type {
  AppSettings,
  DownloadProgress,
  LaunchConfig,
  LoginProgress,
  ModLoader,
  ResourceDependency,
  ResourceInstallTarget,
  ResourceSearchOptions,
  ResourceSource,
  ResourceType,
  SkinVariant,
  VersionFolderKind,
  VersionInstallOptions,
} from '@shared/types';
import * as auth from '../auth';
import * as versions from '../versions';
import * as launcher from '../launch/launcher';
import {
  buildReport,
  diagnoseStartupFailure,
  getLastCrash,
  preferredLogFile,
  reportFileName,
} from '../launch/crash';
import * as javaDetector from '../java/detector';
import * as resources from '../resources';
import * as slatt from '../slatt';
import * as javaInstaller from '../java/installer';
import { getSettings, updateSettings } from '../settings/store';

function broadcast(channel: string, data: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, data);
  }
}

export function registerIpc(): void {
  // ---- settings ----
  ipcMain.handle(IPC.settingsGet, () => getSettings());
  ipcMain.handle(IPC.settingsUpdate, (_e, patch: Partial<AppSettings>) => updateSettings(patch));

  // ---- accounts / auth ----
  ipcMain.handle(IPC.accountList, () => auth.listAccounts());
  ipcMain.handle(IPC.accountLoginOffline, (_e, username: string) => auth.loginOffline(username));
  ipcMain.handle(IPC.accountLoginMicrosoft, () =>
    auth.loginMicrosoft((p: LoginProgress) => broadcast(IPC.eventLoginProgress, p)),
  );
  ipcMain.handle(IPC.accountLoginMicrosoftCancel, () => auth.cancelMicrosoftLogin());
  ipcMain.handle(IPC.accountLoginLittleSkin, (_e, username: string, password: string, remember?: boolean) =>
    auth.loginLittleSkin(username, password, remember !== false),
  );
  ipcMain.handle(IPC.accountRemove, (_e, id: string) => auth.removeAccount(id));
  ipcMain.handle(IPC.accountSelect, (_e, id: string | null) => auth.selectAccount(id));
  ipcMain.handle(IPC.accountUploadSkin, (_e, accountId: string, variant: 'classic' | 'slim', pngBase64: string) =>
    auth.uploadSkin(accountId, variant, pngBase64),
  );
  ipcMain.handle(IPC.accountResetSkin, (_e, accountId: string) => auth.resetSkin(accountId));
  ipcMain.handle(IPC.accountGetSkin, (_e, accountId: string, force?: boolean) => auth.getSkin(accountId, force === true));
  ipcMain.handle(
    IPC.accountSetLocalSkin,
    (_e, accountId: string, pngBase64: string, variant?: SkinVariant) =>
      auth.setLocalSkin(accountId, pngBase64, variant),
  );
  ipcMain.handle(IPC.accountSkinVariant, (_e, accountId: string) => auth.getSkinVariant(accountId));
  ipcMain.handle(IPC.accountLookupSkin, (_e, username: string) => auth.lookupSkinByUsername(username));
  ipcMain.handle(IPC.accountApplySkin, (_e, accountId: string, username: string) => auth.applySkinFromUsername(accountId, username));
  ipcMain.handle(IPC.accountRememberedLogins, () => auth.listRememberedLogins());
  ipcMain.handle(IPC.accountLittleSkinRoles, (_e, accountId: string, password?: string, loginName?: string) =>
    auth.listLittleSkinRoles(accountId, password, loginName),
  );
  ipcMain.handle(
    IPC.accountSwitchRole,
    (_e, accountId: string, roleId: string, password: string, loginName?: string) =>
      auth.switchLittleSkinRole(accountId, roleId, password, loginName),
  );

  // ---- versions ----
  ipcMain.handle(IPC.versionsRemote, () => versions.listRemoteVersions());
  ipcMain.handle(IPC.versionsLocal, () => versions.listLocalVersions());
  ipcMain.handle(IPC.versionsInstall, (_e, id: string, options: VersionInstallOptions) =>
    versions.installVersion(id, options ?? {}, (p) => broadcast(IPC.eventDownloadProgress, p)),
  );
  ipcMain.handle(IPC.versionsLoaderVersions, (_e, loader: ModLoader, mcVersion: string) =>
    versions.listLoaderVersions(loader, mcVersion),
  );
  ipcMain.handle(IPC.versionsJavaRequirement, (_e, versionId: string) => versions.getJavaRequirement(versionId));
  ipcMain.handle(IPC.versionsRemove, (_e, id: string) => versions.removeVersion(id));
  ipcMain.handle(IPC.versionsRepair, (_e, id: string) =>
    versions.repairVersion(id, (p) => broadcast(IPC.eventDownloadProgress, p)),
  );
  ipcMain.handle(IPC.versionsCancel, () => {
    // A modpack install spans two owners: the version installer (while the base
    // version is being created) and the resource module (while the pack's own files
    // download). Abort both so "cancel" is never a no-op.
    versions.cancelDownload();
    resources.cancelModpackInstall();
  });
  ipcMain.handle(IPC.versionsRename, (_e, id: string, newName: string) => versions.renameVersion(id, newName));
  ipcMain.handle(IPC.versionsPaths, (_e, id: string) => versions.getVersionPaths(id));
  ipcMain.handle(IPC.versionsOpenFolder, (_e, id: string, kind: VersionFolderKind) => versions.openVersionFolder(id, kind));
  ipcMain.handle(IPC.versionsContents, (_e, id: string) => versions.listVersionContents(id));
  ipcMain.handle(IPC.versionsModIcons, (_e, id: string) => versions.listModIcons(id));
  ipcMain.handle(IPC.versionsToggleMod, (_e, id: string, name: string) => versions.toggleMod(id, name));
  ipcMain.handle(IPC.versionsDeleteContent, (_e, id: string, kind: 'mods' | 'shaderpacks' | 'saves', name: string) =>
    versions.deleteVersionContent(id, kind, name),
  );
  ipcMain.handle(IPC.versionsGameDirs, () => versions.listGameDirInfos());
  ipcMain.handle(IPC.versionsAddGameDir, async () => {
    const res = await dialog.showOpenDialog({
      title: '选择游戏文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return versions.listGameDirInfos();
    return versions.addGameDir(res.filePaths[0]);
  });
  ipcMain.handle(IPC.versionsRemoveGameDir, (_e, path: string) => versions.removeGameDir(path));
  ipcMain.handle(IPC.versionsSetGameDir, (_e, path: string) => versions.setActiveGameDir(path));
  ipcMain.handle(IPC.screenshotsList, (_e, id: string) => versions.listScreenshots(id));
  ipcMain.handle(IPC.screenshotsRead, (_e, id: string, name: string) => versions.readScreenshot(id, name));
  ipcMain.handle(IPC.screenshotsCopy, (_e, id: string, name: string) => versions.copyScreenshot(id, name));
  ipcMain.handle(IPC.screenshotsDelete, (_e, id: string, name: string) => versions.deleteScreenshot(id, name));
  ipcMain.handle(IPC.screenshotsOpen, (_e, id: string, name: string) => versions.openScreenshot(id, name));

  // ---- java ----
  ipcMain.handle(IPC.javaDetect, () => javaDetector.detectJava());
  ipcMain.handle(IPC.javaInstall, (_e, major: number) =>
    javaInstaller.installJava(major, (p) => broadcast(IPC.eventJavaInstallProgress, p)),
  );
  ipcMain.handle(IPC.javaCancel, () => javaInstaller.cancelJavaInstall());
  ipcMain.handle(IPC.javaImportFile, async () => {
    const res = await dialog.showOpenDialog({
      title: '选择 Java 可执行文件',
      properties: ['openFile'],
      filters: [{ name: 'Java 可执行文件', extensions: ['exe'] }],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const filePath = res.filePaths[0];
    const info = await javaDetector.readJavaInfo(filePath);
    if (!info) throw new Error('无法读取所选文件的 Java 版本信息,请确认选择的是 java.exe 或 javaw.exe');
    // Persist the manually imported path.
    const s = getSettings();
    const list = s.manualJavaPaths ?? [];
    if (!list.includes(filePath)) {
      updateSettings({ manualJavaPaths: [...list, filePath] });
    }
    return {
      path: filePath,
      version: info.version,
      major: info.major,
      is64Bit: info.is64Bit,
      source: 'manual',
      isManaged: false,
    } as const;
  });

  // ---- launch ----
  ipcMain.handle(IPC.launchStart, async (_e, config: LaunchConfig) => {
    try {
      await launcher.startGame(
        config,
        (o) => broadcast(IPC.eventGameOutput, o),
        (p) => broadcast(IPC.eventDownloadProgress, p),
        (info) => broadcast(IPC.eventGameCrash, info),
      );
    } catch (e) {
      // Failing before the process exists (missing Java, broken version files…)
      // is exactly the "cannot start" case the crash dialog is for.
      const message = e instanceof Error ? e.message : String(e);
      broadcast(IPC.eventGameCrash, diagnoseStartupFailure(config.version, message));
      throw e;
    }
  });
  ipcMain.handle(IPC.launchKill, () => launcher.killGame());

  // ---- crash report actions ----
  ipcMain.handle(IPC.crashOpenLog, async () => {
    const info = getLastCrash();
    const file = info ? preferredLogFile(info) : null;
    if (!file) return false;
    // openPath resolves to '' on success, an error string otherwise.
    return (await shell.openPath(file)) === '';
  });
  ipcMain.handle(IPC.crashExport, async () => {
    const info = getLastCrash();
    if (!info) return null;
    const res = await dialog.showSaveDialog({
      title: '导出错误报告',
      defaultPath: join(app.getPath('documents'), reportFileName(info)),
      filters: [{ name: '文本文件', extensions: ['txt'] }],
    });
    if (res.canceled || !res.filePath) return null;
    writeFileSync(res.filePath, buildReport(info), 'utf8');
    return res.filePath;
  });

  // ---- SLATT team account (slatt.cn SSO) + team skin library ----
  ipcMain.handle(IPC.slattLogin, (_e, account: string, password: string) => slatt.login(account, password));
  ipcMain.handle(IPC.slattLogout, () => slatt.logout());
  ipcMain.handle(IPC.slattSession, () => slatt.currentSession());
  ipcMain.handle(IPC.slattRestore, () => slatt.restoreSession());
  ipcMain.handle(IPC.slattRefresh, () => slatt.refreshProfile());
  ipcMain.handle(IPC.slattSkins, (_e, force?: boolean) => slatt.listSkins(force));
  ipcMain.handle(IPC.slattApplySkin, (_e, accountId: string, skinId: number) =>
    slatt.applySkin(accountId, skinId),
  );
  ipcMain.handle(IPC.slattSaveSkin, (_e, skinId: number, dir: string) =>
    slatt.saveSkinToFolder(skinId, dir),
  );

  // ---- resource downloads (mods / resource packs / shaders / datapacks / modpacks) ----
  ipcMain.handle(IPC.resourcesSearch, (_e, type: ResourceType, query: string, options?: ResourceSearchOptions) =>
    resources.searchResources(type, query, options),
  );
  ipcMain.handle(IPC.resourcesVersions, (_e, type: ResourceType, projectId: string, options?: ResourceSearchOptions) =>
    resources.listResourceVersions(type, projectId, options),
  );
  ipcMain.handle(
    IPC.resourcesGameVersions,
    (_e, projectId: string, source?: ResourceSource) =>
      resources.supportedGameSupport(projectId, source),
  );
  ipcMain.handle(
    IPC.resourcesDependencies,
    (
      _e,
      type: ResourceType,
      deps: ResourceDependency[],
      options: {
        source: ResourceSource;
        gameVersions?: string[];
        loaders?: string[];
        target: ResourceInstallTarget;
      },
    ) => resources.resolveResourceDependencies(type, deps, options),
  );
  ipcMain.handle(
    IPC.resourcesInstall,
    (
      _e,
      type: ResourceType,
      projectId: string,
      versionId: string,
      target: ResourceInstallTarget,
      source?: ResourceSource,
    ) => resources.installResource(type, projectId, versionId, target, source ?? 'modrinth'),
  );
  ipcMain.handle(
    IPC.resourcesInstallModpack,
    (_e, projectId: string, versionId: string, name?: string, source?: ResourceSource) =>
      resources.installModpack(
        projectId,
        versionId,
        name,
        (p: DownloadProgress) => broadcast(IPC.eventDownloadProgress, p),
        source ?? 'modrinth',
      ),
  );
  ipcMain.handle(IPC.resourcesInstalled, (_e, type: ResourceType, target: ResourceInstallTarget) =>
    resources.listInstalledResources(type, target),
  );
  ipcMain.handle(IPC.resourcesRemove, (_e, type: ResourceType, filename: string, target: ResourceInstallTarget) =>
    resources.removeResource(type, filename, target),
  );
  ipcMain.handle(IPC.resourcesTargetDir, (_e, type: ResourceType, target: ResourceInstallTarget) =>
    resources.getTargetDir(type, target),
  );
  ipcMain.handle(IPC.resourcesMcmodLink, (_e, title: string) => resources.mcmodLink(title));
  /**
   * Chinese names for a page of cards.
   *
   * Returns only what is already cached (so the call is instant) and queues the
   * rest in the background; each newly resolved name is pushed back through
   * `resourcesZhNameResolved`. Blocking here would stall the list for ~20s, since
   * mcmod allows about one request per second.
   */
  ipcMain.handle(IPC.resourcesZhNames, (_e, titles: string[]) => {
    const known = resources.cachedZhNames(titles);
    resources.queueZhNames(titles);
    return known;
  });
  resources.onZhNameResolved((payload) => broadcast(IPC.resourcesZhNameResolved, payload));

  // ---- misc ----
  ipcMain.handle(IPC.openExternal, (_e, url: string) => shell.openExternal(url));
  ipcMain.handle(IPC.selectDirectory, async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return res.canceled ? null : res.filePaths[0];
  });

  // ---- window controls (the renderer draws a custom frameless title bar) ----
  const senderWindow = (e: Electron.IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(e.sender);
  ipcMain.handle(IPC.winMinimize, (e) => senderWindow(e)?.minimize());
  ipcMain.handle(IPC.winToggleMaximize, (e) => {
    const win = senderWindow(e);
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle(IPC.winClose, (e) => senderWindow(e)?.close());
  ipcMain.handle(IPC.winIsMaximized, (e) => senderWindow(e)?.isMaximized() ?? false);
}
