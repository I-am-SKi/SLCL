import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc';
import type {
  AccountProfile,
  AppSettings,
  DownloadProgress,
  GameDirInfo,
  CrashInfo,
  GameOutput,
  JavaInstallation,
  JavaRequirement,
  LocalMinecraftVersion,
  LittleSkinRoles,
  LoginProgress,
  ModpackInstallResult,
  RemoteMinecraftVersion,
  ResourceFileInfo,
  ResourceInstallResult,
  ResolvedDependency,
  ResourceSearchResult,
  ResourceVersion,
  ScreenshotInfo,
  SkinLookupResult,
  SkinVariant,
  SlattApplyResult,
  SlattSession,
  SlattSkin,
  VersionContents,
  VersionPaths,
} from '../shared/types';
import type { SlclApi } from '../shared/api';

function subscribe<T>(channel: string) {
  return (cb: (data: T) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, data: T): void => cb(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

const api: SlclApi = {
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet) as Promise<AppSettings>,
    update: (patch) => ipcRenderer.invoke(IPC.settingsUpdate, patch) as Promise<AppSettings>,
  },
  accounts: {
    list: () => ipcRenderer.invoke(IPC.accountList) as Promise<AccountProfile[]>,
    loginOffline: (username) => ipcRenderer.invoke(IPC.accountLoginOffline, username) as Promise<AccountProfile>,
    loginMicrosoft: () => ipcRenderer.invoke(IPC.accountLoginMicrosoft) as Promise<AccountProfile>,
    cancelMicrosoft: () => ipcRenderer.invoke(IPC.accountLoginMicrosoftCancel) as Promise<void>,
    rememberedLogins: () =>
      ipcRenderer.invoke(IPC.accountRememberedLogins) as Promise<Array<{ loginName: string; password: string }>>,
    loginLittleSkin: (username, password, remember) =>
      ipcRenderer.invoke(IPC.accountLoginLittleSkin, username, password, remember) as Promise<AccountProfile>,
    remove: (id) => ipcRenderer.invoke(IPC.accountRemove, id) as Promise<void>,
    select: (id) => ipcRenderer.invoke(IPC.accountSelect, id) as Promise<void>,
    uploadSkin: (accountId, variant, pngBase64) =>
      ipcRenderer.invoke(IPC.accountUploadSkin, accountId, variant, pngBase64) as Promise<void>,
    resetSkin: (accountId) => ipcRenderer.invoke(IPC.accountResetSkin, accountId) as Promise<void>,
    getSkin: (accountId, force) => ipcRenderer.invoke(IPC.accountGetSkin, accountId, force ?? false) as Promise<string>,
    refreshSkin: (accountId) => ipcRenderer.invoke(IPC.accountGetSkin, accountId, true) as Promise<string>,
    setLocalSkin: (accountId, pngBase64, variant) =>
      ipcRenderer.invoke(IPC.accountSetLocalSkin, accountId, pngBase64, variant) as Promise<void>,
    skinVariant: (accountId) =>
      ipcRenderer.invoke(IPC.accountSkinVariant, accountId) as Promise<SkinVariant>,
    lookupSkin: (username) => ipcRenderer.invoke(IPC.accountLookupSkin, username) as Promise<SkinLookupResult>,
    littleSkinRoles: (accountId, password, loginName) =>
      ipcRenderer.invoke(IPC.accountLittleSkinRoles, accountId, password, loginName) as Promise<LittleSkinRoles>,
    switchRole: (accountId, roleId, password, loginName) =>
      ipcRenderer.invoke(IPC.accountSwitchRole, accountId, roleId, password, loginName) as Promise<AccountProfile>,
    applySkinFromUsername: (accountId, username) =>
      ipcRenderer.invoke(IPC.accountApplySkin, accountId, username) as Promise<SkinLookupResult>,
    onLoginProgress: subscribe<LoginProgress>(IPC.eventLoginProgress),
  },
  versions: {
    remote: () => ipcRenderer.invoke(IPC.versionsRemote) as Promise<RemoteMinecraftVersion[]>,
    local: () => ipcRenderer.invoke(IPC.versionsLocal) as Promise<LocalMinecraftVersion[]>,
    install: (id, options) => ipcRenderer.invoke(IPC.versionsInstall, id, options) as Promise<string>,
    loaderVersions: (loader, mcVersion) =>
      ipcRenderer.invoke(IPC.versionsLoaderVersions, loader, mcVersion) as Promise<string[]>,
    javaRequirement: (versionId) =>
      ipcRenderer.invoke(IPC.versionsJavaRequirement, versionId) as Promise<JavaRequirement>,
    remove: (id) => ipcRenderer.invoke(IPC.versionsRemove, id) as Promise<void>,
    repair: (id) => ipcRenderer.invoke(IPC.versionsRepair, id) as Promise<number>,
    cancel: () => ipcRenderer.invoke(IPC.versionsCancel) as Promise<void>,
    rename: (id, newName) => ipcRenderer.invoke(IPC.versionsRename, id, newName) as Promise<void>,
    paths: (id) => ipcRenderer.invoke(IPC.versionsPaths, id) as Promise<VersionPaths>,
    openFolder: (id, kind) => ipcRenderer.invoke(IPC.versionsOpenFolder, id, kind) as Promise<void>,
    contents: (id) => ipcRenderer.invoke(IPC.versionsContents, id) as Promise<VersionContents>,
    modIcons: (id) => ipcRenderer.invoke(IPC.versionsModIcons, id) as Promise<Record<string, string | null>>,
    toggleMod: (id, name) => ipcRenderer.invoke(IPC.versionsToggleMod, id, name) as Promise<void>,
    deleteContent: (id, kind, name) =>
      ipcRenderer.invoke(IPC.versionsDeleteContent, id, kind, name) as Promise<void>,
    gameDirs: () => ipcRenderer.invoke(IPC.versionsGameDirs) as Promise<GameDirInfo[]>,
    addGameDir: () => ipcRenderer.invoke(IPC.versionsAddGameDir) as Promise<GameDirInfo[]>,
    removeGameDir: (path) => ipcRenderer.invoke(IPC.versionsRemoveGameDir, path) as Promise<GameDirInfo[]>,
    setGameDir: (path) => ipcRenderer.invoke(IPC.versionsSetGameDir, path) as Promise<GameDirInfo[]>,
    screenshots: (id) => ipcRenderer.invoke(IPC.screenshotsList, id) as Promise<ScreenshotInfo[]>,
    screenshotData: (id, name) => ipcRenderer.invoke(IPC.screenshotsRead, id, name) as Promise<string>,
    copyScreenshot: (id, name) => ipcRenderer.invoke(IPC.screenshotsCopy, id, name) as Promise<void>,
    deleteScreenshot: (id, name) => ipcRenderer.invoke(IPC.screenshotsDelete, id, name) as Promise<void>,
    openScreenshot: (id, name) => ipcRenderer.invoke(IPC.screenshotsOpen, id, name) as Promise<void>,
    onProgress: subscribe<DownloadProgress>(IPC.eventDownloadProgress),
  },
  java: {
    detect: () => ipcRenderer.invoke(IPC.javaDetect) as Promise<JavaInstallation[]>,
    install: (major) => ipcRenderer.invoke(IPC.javaInstall, major) as Promise<JavaInstallation>,
    cancel: () => ipcRenderer.invoke(IPC.javaCancel) as Promise<void>,
    importFile: () => ipcRenderer.invoke(IPC.javaImportFile) as Promise<JavaInstallation | null>,
    onProgress: subscribe<DownloadProgress>(IPC.eventJavaInstallProgress),
  },
  launch: {
    start: (config) => ipcRenderer.invoke(IPC.launchStart, config) as Promise<void>,
    kill: () => ipcRenderer.invoke(IPC.launchKill) as Promise<void>,
    onOutput: subscribe<GameOutput>(IPC.eventGameOutput),
    onCrash: subscribe<CrashInfo>(IPC.eventGameCrash),
  },
  crash: {
    openLog: () => ipcRenderer.invoke(IPC.crashOpenLog) as Promise<boolean>,
    exportReport: () => ipcRenderer.invoke(IPC.crashExport) as Promise<string | null>,
  },
  slatt: {
    login: (account, password) => ipcRenderer.invoke(IPC.slattLogin, account, password) as Promise<SlattSession>,
    logout: () => ipcRenderer.invoke(IPC.slattLogout) as Promise<void>,
    session: () => ipcRenderer.invoke(IPC.slattSession) as Promise<SlattSession | null>,
    restore: () => ipcRenderer.invoke(IPC.slattRestore) as Promise<SlattSession | null>,
    refresh: () => ipcRenderer.invoke(IPC.slattRefresh) as Promise<SlattSession>,
    skins: (force) => ipcRenderer.invoke(IPC.slattSkins, force) as Promise<SlattSkin[]>,
    applySkin: (accountId, skinId) =>
      ipcRenderer.invoke(IPC.slattApplySkin, accountId, skinId) as Promise<SlattApplyResult>,
    saveSkin: (skinId, dir) => ipcRenderer.invoke(IPC.slattSaveSkin, skinId, dir) as Promise<string>,
  },
  resources: {
    search: (type, query, options) =>
      ipcRenderer.invoke(IPC.resourcesSearch, type, query, options) as Promise<ResourceSearchResult>,
    versions: (type, projectId, options) =>
      ipcRenderer.invoke(IPC.resourcesVersions, type, projectId, options) as Promise<ResourceVersion[]>,
    support: (projectId, source) =>
      ipcRenderer.invoke(IPC.resourcesGameVersions, projectId, source) as Promise<{
        gameVersions: string[];
        loaders: string[];
      }>,
    dependencies: (type, dependencies, options) =>
      ipcRenderer.invoke(IPC.resourcesDependencies, type, dependencies, options) as Promise<
        ResolvedDependency[]
      >,
    install: (type, projectId, versionId, target, source) =>
      ipcRenderer.invoke(IPC.resourcesInstall, type, projectId, versionId, target, source) as Promise<ResourceInstallResult>,
    installModpack: (projectId, versionId, name, source) =>
      ipcRenderer.invoke(IPC.resourcesInstallModpack, projectId, versionId, name, source) as Promise<ModpackInstallResult>,
    installed: (type, target) =>
      ipcRenderer.invoke(IPC.resourcesInstalled, type, target) as Promise<ResourceFileInfo[]>,
    remove: (type, filename, target) =>
      ipcRenderer.invoke(IPC.resourcesRemove, type, filename, target) as Promise<void>,
    mcmod: (title) =>
      ipcRenderer.invoke(IPC.resourcesMcmodLink, title) as Promise<{ url: string | null; search: string }>,
    zhNames: (titles) => ipcRenderer.invoke(IPC.resourcesZhNames, titles) as Promise<Record<string, string>>,
    onZhName: (cb) => subscribe<{ title: string; zh: string }>(IPC.resourcesZhNameResolved)(cb),
    targetDir: (type, target) =>
      ipcRenderer.invoke(IPC.resourcesTargetDir, type, target) as Promise<string>,
  },
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url) as Promise<void>,
  selectDirectory: () => ipcRenderer.invoke(IPC.selectDirectory) as Promise<string | null>,
  window: {
    minimize: () => ipcRenderer.invoke(IPC.winMinimize) as Promise<void>,
    toggleMaximize: () => ipcRenderer.invoke(IPC.winToggleMaximize) as Promise<boolean>,
    close: () => ipcRenderer.invoke(IPC.winClose) as Promise<void>,
    isMaximized: () => ipcRenderer.invoke(IPC.winIsMaximized) as Promise<boolean>,
    onMaximized: subscribe<boolean>(IPC.eventWinMaximized),
  },
};

contextBridge.exposeInMainWorld('slcl', api);
