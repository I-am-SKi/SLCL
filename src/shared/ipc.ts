/**
 * IPC channel names + the typed surface exposed to the renderer via `window.slcl`.
 * Keep in sync with src/preload/index.ts and src/main/ipc/index.ts.
 */

export const IPC = {
  // settings
  settingsGet: 'slcl:settings:get',
  settingsUpdate: 'slcl:settings:update',
  // accounts / auth
  accountList: 'slcl:account:list',
  accountLoginOffline: 'slcl:account:login-offline',
  accountLoginMicrosoft: 'slcl:account:login-microsoft',
  accountLoginMicrosoftCancel: 'slcl:account:login-microsoft-cancel',
  accountRemove: 'slcl:account:remove',
  accountSelect: 'slcl:account:select',
  accountUploadSkin: 'slcl:account:upload-skin',
  accountResetSkin: 'slcl:account:reset-skin',
  accountGetSkin: 'slcl:account:get-skin',
  accountSetLocalSkin: 'slcl:account:set-local-skin',
  accountLookupSkin: 'slcl:account:lookup-skin',
  accountApplySkin: 'slcl:account:apply-skin',
  accountLoginLittleSkin: 'slcl:account:login-littleskin',
  // events from main -> renderer
  eventLoginProgress: 'slcl:event:login-progress',
  eventDownloadProgress: 'slcl:event:download-progress',
  eventJavaInstallProgress: 'slcl:event:java-install-progress',
  eventGameOutput: 'slcl:event:game-output',
  eventGameCrash: 'slcl:event:game-crash',
  // versions
  versionsRemote: 'slcl:versions:remote',
  versionsLocal: 'slcl:versions:local',
  versionsInstall: 'slcl:versions:install',
  versionsLoaderVersions: 'slcl:versions:loader-versions',
  versionsJavaRequirement: 'slcl:versions:java-requirement',
  versionsRemove: 'slcl:versions:remove',
  versionsRepair: 'slcl:versions:repair',
  versionsCancel: 'slcl:versions:cancel',
  versionsRename: 'slcl:versions:rename',
  versionsPaths: 'slcl:versions:paths',
  versionsOpenFolder: 'slcl:versions:open-folder',
  versionsContents: 'slcl:versions:contents',
  versionsModIcons: 'slcl:versions:mod-icons',
  versionsToggleMod: 'slcl:versions:toggle-mod',
  versionsDeleteContent: 'slcl:versions:delete-content',
  versionsGameDirs: 'slcl:versions:game-dirs',
  versionsAddGameDir: 'slcl:versions:add-game-dir',
  versionsRemoveGameDir: 'slcl:versions:remove-game-dir',
  versionsSetGameDir: 'slcl:versions:set-game-dir',
  screenshotsList: 'slcl:screenshots:list',
  screenshotsRead: 'slcl:screenshots:read',
  screenshotsCopy: 'slcl:screenshots:copy',
  screenshotsDelete: 'slcl:screenshots:delete',
  screenshotsOpen: 'slcl:screenshots:open',
  // java
  javaDetect: 'slcl:java:detect',
  javaInstall: 'slcl:java:install',
  javaCancel: 'slcl:java:cancel',
  javaImportFile: 'slcl:java:import-file',
  // launch
  launchStart: 'slcl:launch:start',
  launchKill: 'slcl:launch:kill',
  // crash report dialog actions
  crashOpenLog: 'slcl:crash:open-log',
  crashExport: 'slcl:crash:export',
  // resources (Modrinth content: mods / resource packs / shaders / datapacks / modpacks)
  resourcesSearch: 'slcl:resources:search',
  resourcesVersions: 'slcl:resources:versions',
  resourcesInstall: 'slcl:resources:install',
  resourcesInstallModpack: 'slcl:resources:install-modpack',
  resourcesInstalled: 'slcl:resources:installed',
  resourcesRemove: 'slcl:resources:remove',
  resourcesTargetDir: 'slcl:resources:target-dir',
  // misc
  openExternal: 'slcl:open-external',
  selectDirectory: 'slcl:select-directory',
  // window controls (frameless custom title bar)
  winMinimize: 'slcl:win:minimize',
  winToggleMaximize: 'slcl:win:toggle-maximize',
  winClose: 'slcl:win:close',
  winIsMaximized: 'slcl:win:is-maximized',
  eventWinMaximized: 'slcl:event:win-maximized',
} as const;
