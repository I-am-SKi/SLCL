/**
 * Typed surface exposed to the renderer via `window.slcl`.
 * Implemented in src/preload/index.ts, consumed by src/renderer/src.
 */
import type {
  AccountProfile,
  AppSettings,
  CrashInfo,
  DownloadProgress,
  GameDirInfo,
  GameOutput,
  JavaInstallation,
  JavaRequirement,
  LaunchConfig,
  LittleSkinRoles,
  LocalMinecraftVersion,
  LoginProgress,
  ModLoader,
  ModpackInstallResult,
  RemoteMinecraftVersion,
  ResourceFileInfo,
  ResourceInstallResult,
  ResourceInstallTarget,
  ResolvedDependency,
  ResourceDependency,
  ResourceSearchOptions,
  ResourceSearchResult,
  ResourceSource,
  ResourceType,
  ResourceVersion,
  ScreenshotInfo,
  SkinLookupResult,
  SkinVariant,
  SlattApplyResult,
  SlattSession,
  SlattSkin,
  VersionContents,
  VersionFolderKind,
  VersionInstallOptions,
  VersionPaths,
} from './types';

export interface SlclApi {
  settings: {
    get(): Promise<AppSettings>;
    update(patch: Partial<AppSettings>): Promise<AppSettings>;
  };
  accounts: {
    list(): Promise<AccountProfile[]>;
    loginOffline(username: string): Promise<AccountProfile>;
    loginMicrosoft(): Promise<AccountProfile>;
    cancelMicrosoft(): Promise<void>;
    /**
     * Sign in to LittleSkin. remember stores the password (DPAPI-encrypted) so
     * switching characters later does not have to ask for it again.
     */
    loginLittleSkin(username: string, password: string, remember?: boolean): Promise<AccountProfile>;
    /** Remembered LittleSkin logins, used to prefill the sign-in form. */
    rememberedLogins(): Promise<Array<{ loginName: string; password: string }>>;
    remove(id: string): Promise<void>;
    select(id: string | null): Promise<void>;
    /** Upload a skin (PNG, base64) for a Microsoft account. */
    uploadSkin(accountId: string, variant: 'classic' | 'slim', pngBase64: string): Promise<void>;
    /** Reset a Microsoft account's skin to default. */
    resetSkin(accountId: string): Promise<void>;
    /**
     * Get the skin (data URL) to display for an account.
     * `force` bypasses the memory/disk TTL cache and re-downloads from Mojang/mirrors.
     */
    getSkin(accountId: string, force?: boolean): Promise<string>;
    /** Force a fresh skin lookup (ignores caches). Same as `getSkin(id, true)`. */
    refreshSkin(accountId: string): Promise<string>;
    /**
     * Save a locally-picked PNG (base64) as this account's skin.
     *
     * For offline accounts this is the skin the game will actually show: the
     * launcher serves it through a loopback Yggdrasil server at launch. `variant`
     * is the arm width and is part of the skin's texture metadata, so it must be
     * stored alongside the image.
     */
    setLocalSkin(accountId: string, pngBase64: string, variant?: SkinVariant): Promise<void>;
    /** Arm width of the account's local skin (defaults to classic). */
    skinVariant(accountId: string): Promise<SkinVariant>;
    /** Look up a premium account's skin by username (no auth required). */
    lookupSkin(username: string): Promise<SkinLookupResult>;
    /** Apply a premium account's skin to a local account (saved to cache). */
    applySkinFromUsername(accountId: string, username: string): Promise<SkinLookupResult>;
    /**
     * LittleSkin only: the Minecraft characters this account can sign in as.
     * Pass a password to read the authoritative list (needed for accounts that
     * signed in before the launcher cached it).
     */
    littleSkinRoles(accountId: string, password?: string, loginName?: string): Promise<LittleSkinRoles>;
    /**
     * LittleSkin only: switch the account to another character.
     *
     * Yggdrasil can bind a character to a fresh token but never rebind an existing
     * one, so a new unbound token is required — which means re-authenticating.
     * `password` may be omitted: the remembered credential is used automatically.
     */
    switchRole(
      accountId: string,
      roleId: string,
      password?: string,
      loginName?: string,
    ): Promise<AccountProfile>;
    /** Subscribe to Microsoft login progress. Returns an unsubscribe fn. */
    onLoginProgress(cb: (p: LoginProgress) => void): () => void;
  };
  versions: {
    remote(): Promise<RemoteMinecraftVersion[]>;
    local(): Promise<LocalMinecraftVersion[]>;
    install(id: string, options?: VersionInstallOptions): Promise<string>;
    /** All stable versions of a mod loader for a Minecraft version, newest first. */
    loaderVersions(loader: ModLoader, mcVersion: string): Promise<string[]>;
    /** Java major this version needs, and whether an installed runtime satisfies it. */
    javaRequirement(versionId: string): Promise<JavaRequirement>;
    remove(id: string): Promise<void>;
    /** Repair missing/corrupt files for an installed version. Returns number of files downloaded. */
    repair(id: string): Promise<number>;
    /** Cancel the currently running install/repair and delete partial files. */
    cancel(): Promise<void>;
    /** Rename an installed version (folder + json id + jar). */
    rename(id: string, newName: string): Promise<void>;
    /** Resolve on-disk paths for a version. */
    paths(id: string): Promise<VersionPaths>;
    /** Open a version-related folder in the OS file manager. */
    openFolder(id: string, kind: VersionFolderKind): Promise<void>;
    /** List the mods/shaderpacks/saves contents of a version. */
    contents(id: string): Promise<VersionContents>;
    /** Resolve each mod's bundled icon (data URL); null when the mod has none. */
    modIcons(id: string): Promise<Record<string, string | null>>;
    /** Enable/disable a mod by renaming it to/from `<name>.jar.disabled`. */
    toggleMod(id: string, filename: string): Promise<void>;
    /** Delete a mod file, shaderpack, or save folder. */
    deleteContent(id: string, kind: 'mods' | 'shaderpacks' | 'saves', name: string): Promise<void>;
    /** All known game roots (folders that may contain installed versions). */
    gameDirs(): Promise<GameDirInfo[]>;
    /** Prompt for a folder and add it to the scanned list. Returns the updated list. */
    addGameDir(): Promise<GameDirInfo[]>;
    /** Stop scanning a folder (does not delete anything on disk). */
    removeGameDir(path: string): Promise<GameDirInfo[]>;
    /** Make a folder the active root for new installs. */
    setGameDir(path: string): Promise<GameDirInfo[]>;
    /** List screenshot files of a version. */
    screenshots(id: string): Promise<ScreenshotInfo[]>;
    /** Read a screenshot as a base64 data URL. */
    screenshotData(id: string, name: string): Promise<string>;
    /** Copy a screenshot to the clipboard. */
    copyScreenshot(id: string, name: string): Promise<void>;
    /** Delete a screenshot. */
    deleteScreenshot(id: string, name: string): Promise<void>;
    /** Open a screenshot in the OS image viewer. */
    openScreenshot(id: string, name: string): Promise<void>;
    onProgress(cb: (p: DownloadProgress) => void): () => void;
  };
  java: {
    detect(): Promise<JavaInstallation[]>;
    /** Install a Java runtime (Adoptium Temurin JRE) for the given major version. */
    install(major: number): Promise<JavaInstallation>;
    /** Cancel the currently running Java install. */
    cancel(): Promise<void>;
    /** Manually import a java.exe/javaw.exe file. Returns the installation or null if canceled. */
    importFile(): Promise<JavaInstallation | null>;
    /** Subscribe to Java install/download progress. Returns an unsubscribe fn. */
    onProgress(cb: (p: DownloadProgress) => void): () => void;
  };
  launch: {
    start(config: LaunchConfig): Promise<void>;
    kill(): Promise<void>;
    onOutput(cb: (o: GameOutput) => void): () => void;
    /** Fires when a launch ends in a crash (never for a clean quit). */
    onCrash(cb: (info: CrashInfo) => void): () => void;
  };
  crash: {
    /** Open the game log (or crash report) in the OS default viewer. */
    openLog(): Promise<boolean>;
    /** Ask for a save location and write the error report. Returns the path, or null if cancelled. */
    exportReport(): Promise<string | null>;
  };
  /**
   * SLATT team site (slatt.cn) integration. Team-members-only: the site itself
   * only allows team members to register.
   */
  slatt: {
    /** Sign in with the site account. Throws with a human-readable message. */
    login(account: string, password: string): Promise<SlattSession>;
    /** Revoke the launcher session and forget the token locally. */
    logout(): Promise<void>;
    /** Cached session, without touching the network. */
    session(): Promise<SlattSession | null>;
    /** Validate the stored token against the site (used on startup). */
    restore(): Promise<SlattSession | null>;
    /** Re-read the member profile, e.g. after changing the skin on the site. */
    refresh(): Promise<SlattSession>;
    /** The whole team skin library. */
    skins(force?: boolean): Promise<SlattSkin[]>;
    /** Install a library skin onto a Minecraft account. */
    applySkin(accountId: string, skinId: number): Promise<SlattApplyResult>;
    /** Save a library skin as a PNG into an arbitrary folder. Returns the written path. */
    saveSkin(skinId: number, dir: string): Promise<string>;
  };
  resources: {
    /**
     * Search the active site for projects of the given type.
     *
     * A keyword containing Chinese is resolved to its English project names via
     * MC百科 first (Modrinth / CurseForge only index English titles), so typing
     * "机械动力" finds Create. `translatedQuery` reports that mapping.
     */
    search(
      type: ResourceType,
      query: string,
      options?: ResourceSearchOptions,
    ): Promise<ResourceSearchResult>;
    /**
     * List the downloadable versions of a project (newest first) — this powers the
     * "historical versions" picker. Filter by game version / loader when given.
     */
    versions(
      type: ResourceType,
      projectId: string,
      options?: ResourceSearchOptions,
    ): Promise<ResourceVersion[]>;
    /**
     * Every Minecraft version and mod loader the project ships files for.
     *
     * Backs the install dialog's filters, which must not offer values the
     * resource never supported.
     */
    support(
      projectId: string,
      source?: ResourceSource,
    ): Promise<{ gameVersions: string[]; loaders: string[] }>;
    /**
     * Resolve a version's declared dependencies ("前置模组") into something the UI
     * can act on: title, the file that would be installed, already-installed state.
     *
     * Only dependencies the author declared are visible here — a mod that silently
     * needs something cannot be detected by any launcher.
     */
    dependencies(
      type: ResourceType,
      dependencies: ResourceDependency[],
      options: {
        source: ResourceSource;
        /** Game versions the dependency must support (from the dependent version). */
        gameVersions?: string[];
        /** Loaders the dependency must support (from the dependent version). */
        loaders?: string[];
        target: ResourceInstallTarget;
      },
    ): Promise<ResolvedDependency[]>;
    /** Download one specific version file into the resolved target folder. */
    install(
      type: ResourceType,
      projectId: string,
      versionId: string,
      target: ResourceInstallTarget,
      source?: ResourceSource,
    ): Promise<ResourceInstallResult>;
    /** Install a modpack (Modrinth .mrpack or CurseForge .zip). Creates a new local version. */
    installModpack(
      projectId: string,
      versionId: string,
      name?: string,
      source?: ResourceSource,
    ): Promise<ModpackInstallResult>;
    /** List the files already present in the target folder for a resource type. */
    installed(type: ResourceType, target: ResourceInstallTarget): Promise<ResourceFileInfo[]>;
    /** Delete an installed resource file from the target folder. */
    remove(type: ResourceType, filename: string, target: ResourceInstallTarget): Promise<void>;
    /** Resolve (and create) the absolute install directory for a type + target combo. */
    targetDir(type: ResourceType, target: ResourceInstallTarget): Promise<string>;
    /** MC百科 entry for a project title (direct URL when matched, plus a search URL). */
    mcmod(title: string): Promise<{ url: string | null; search: string }>;
    /**
     * Chinese names for a page of cards.
     *
     * Resolves immediately with whatever is already cached, and queues the rest in
     * the background — mcmod allows roughly one request per second, so a page of
     * cards takes ~20s to fill in completely on first visit. Newly resolved names
     * arrive through `onZhName`.
     */
    zhNames(titles: string[]): Promise<Record<string, string>>;
    /** Subscribe to Chinese names resolved in the background. */
    onZhName(cb: (payload: { title: string; zh: string }) => void): () => void;
  };
  openExternal(url: string): Promise<void>;
  selectDirectory(): Promise<string | null>;
  /** Controls for the renderer-drawn (frameless) title bar. */
  window: {
    minimize(): Promise<void>;
    /** Toggles maximize/restore; resolves to the new maximized state. */
    toggleMaximize(): Promise<boolean>;
    close(): Promise<void>;
    isMaximized(): Promise<boolean>;
    /** Subscribe to maximize-state changes. Returns an unsubscribe fn. */
    onMaximized(cb: (maximized: boolean) => void): () => void;
  };
}
