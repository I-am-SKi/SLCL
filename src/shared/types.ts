/**
 * Shared types between the Electron main process and renderer.
 * These types must stay free of any main-process-only imports (@xmcl/*, electron, node).
 */

export type AccountType = 'offline' | 'microsoft' | 'littleskin';

/**
 * Arm width of a skin.
 *
 * Minecraft stores this in the skin's texture metadata (`metadata.model`), not in
 * the PNG: `slim` is Alex's 3px arms, `classic` is Steve's 4px ones. Shared so the
 * renderer, the IPC layer and the launch-time skin server all speak the same
 * vocabulary (`slim` also matches what Mojang's upload API and slatt.cn expect).
 */
export type SkinVariant = 'classic' | 'slim';

export interface AccountProfile {
  /** Stable unique id used to reference the account (offline: uuid, microsoft: profile uuid). */
  id: string;
  /** Display name shown in the launcher. */
  name: string;
  type: AccountType;
  /** Raw Mojang UUID (hyphenated) for offline accounts; profile id for Microsoft accounts. */
  uuid: string;
  /** Skin / avatar url when available. */
  skinUrl?: string;
  /** Microsoft access token (kept in memory only, refreshed on demand). */
  accessToken?: string;
  /** LittleSkin Yggdrasil client token (used to refresh `accessToken`). */
  clientToken?: string;
  /**
   * The identifier used to sign in (email or character name).
   *
   * Switching characters requires a fresh, *unbound* token, which only the
   * authenticate call can produce — so the identifier is kept to avoid asking for
   * it again. Signing in with a character name produces an already-bound token,
   * so only an email makes switching possible.
   */
  loginName?: string;
  /**
   * Every Minecraft character available to a LittleSkin account, captured at login.
   * The Yggdrasil API only returns this list from the authenticate response, so it
   * must be persisted to offer role switching later without re-entering a password.
   */
  profiles?: Array<{ id: string; name: string }>;
  /** ISO timestamp of last successful login (microsoft). */
  lastLoginAt?: string;
}

export interface JavaInstallation {
  /** Absolute path to javaw.exe / java.exe */
  path: string;
  /** Human-readable java version, e.g. "17.0.9" */
  version: string;
  /** Major version, e.g. 17 */
  major: number;
  is64Bit: boolean;
  source: 'java_home' | 'path' | 'common_paths' | 'registry' | 'manual';
  /** True when this runtime was installed by SLCL itself. */
  isManaged?: boolean;
}

/** The Java major versions SLCL offers as one-click install presets (Adoptium Temurin). */
export const JAVA_RUNTIME_MAJORS = [8, 11, 17, 21, 25] as const;

/** Any Java major can be installed; this guards obviously invalid input. */
export const JAVA_MAJOR_MIN = 6;
export const JAVA_MAJOR_MAX = 40;

/**
 * Per-game-version launch overrides, edited from 版本管理 → 启动设置.
 * Anything left as 'auto' falls back to the global launcher settings.
 */
export interface VersionLaunchOverride {
  /** 'auto' follows the global max memory; 'custom' uses `maxMemory`. */
  memoryMode: 'auto' | 'custom';
  /** Custom max heap in MB (only used when memoryMode === 'custom'). */
  maxMemory: number;
  /** 'auto' picks a Java matching the version's requirement; 'manual' uses `javaPath`. */
  javaMode: 'auto' | 'manual';
  /** Manual Java executable path (only used when javaMode === 'manual'). */
  javaPath: string;
}

/** Java requirement of an installed version + whether a suitable runtime exists. */
export interface JavaRequirement {
  versionId: string;
  /** Major version the game classes were compiled for (e.g. 25). */
  requiredMajor: number;
  /** Best installed major that can run it, or null when none can. */
  bestMajor: number | null;
  /** True when at least one installed Java can run this version. */
  satisfied: boolean;
}

export type MinecraftVersionType = 'release' | 'snapshot' | 'old_beta' | 'old_alpha';

/** Supported mod loaders that can be installed on top of a vanilla version. */
export type ModLoader = 'fabric' | 'forge' | 'neoforge';

/** Options for installing a version (vanilla or vanilla + mod loader). */
export interface VersionInstallOptions {
  /** Custom version name (folder name / version id). Defaults to the base version or loader default id. */
  name?: string;
  /** Main mod loader (Fabric / Forge / NeoForge) — mutually exclusive, pick at most one. */
  loader?: ModLoader;
  /**
   * Specific loader version to install (e.g. Forge "14.23.5.2864", Fabric "0.16.0").
   * Omit to install the newest stable version.
   */
  loaderVersion?: string;
  /**
   * Fabric only: also install Fabric API into the new version's mods folder.
   * Nearly every Fabric mod needs it, so this defaults to enabled; pass false to skip.
   */
  installFabricApi?: boolean;
}

export interface RemoteMinecraftVersion {
  id: string;
  type: MinecraftVersionType;
  releaseTime: string;
}

export interface LocalMinecraftVersion {
  id: string;
  /** Vanilla version this is based on (best effort). */
  type: string;
  installed: boolean;
  /** Whether Forge/Fabric loader is detected in the version json. */
  hasModLoader: boolean;
  /** The real Minecraft version this is based on (e.g. "1.12.2" for forge/fabric). */
  minecraftVersion: string;
  /** Absolute game root that contains this version (`<dir>/versions/<id>`). */
  dir: string;
  /** Detected mod loader id, or null for vanilla. */
  loader: 'fabric' | 'forge' | 'neoforge' | 'quilt' | null;
}

/** A game root directory (a `.minecraft`-style folder) that can hold versions. */
export interface GameDirInfo {
  path: string;
  /** Whether this directory exists on disk. */
  exists: boolean;
  /** Whether it has a `versions/` sub-folder. */
  hasVersionsDir: boolean;
  /** How many versions were detected. */
  versionCount: number;
  /** The active root — new installs and the game's shared assets go here. */
  active: boolean;
}

/** A sub-folder that can be opened from the versions page. */
export type VersionFolderKind =
  | 'version'
  | 'mods'
  | 'shaderpacks'
  | 'resourcepacks'
  | 'datapacks'
  | 'saves'
  | 'screenshots';

/** Resolved on-disk paths for a given version. */
export interface VersionPaths {
  /** The version folder: <resourcePath>/versions/<id> */
  versionFolder: string;
  /** The effective game directory (isolated folder or shared resource dir). */
  gameDir: string;
  modsFolder: string;
  shaderpacksFolder: string;
  resourcepacksFolder: string;
  /** Global (world-independent) datapack folder. */
  datapacksFolder: string;
  savesFolder: string;
  screenshotsFolder: string;
}

/** A single file/folder entry inside a version's mods/shaderpacks/saves folder. */
export interface VersionContentItem {
  /** File/folder name (folder name for saves & shaderpacks; filename for mods). */
  name: string;
  /** Whether it's a directory. */
  isDir: boolean;
  /** Size in bytes (0 for directories). */
  size: number;
  /** Last-modified timestamp in ms. */
  mtimeMs: number;
  /** For saves: the world name read from level.dat (falls back to folder name). */
  worldName?: string;
  /** For mods: disabled mods are stored on disk as `<name>.disabled`. */
  disabled?: boolean;
}

/** Aggregated contents of a version's game folders. */
export interface VersionContents {
  mods: VersionContentItem[];
  shaderpacks: VersionContentItem[];
  saves: VersionContentItem[];
}

/** A screenshot file in the version's screenshots folder. */
export interface ScreenshotInfo {
  name: string;
  size: number;
  mtimeMs: number;
}

export interface DownloadProgress {
  /** Overall install progress 0..1 */
  progress: number;
  /** Total bytes to download (0 when unknown). */
  totalBytes: number;
  /** Bytes downloaded so far. */
  downloadedBytes: number;
  /** Human readable current task, e.g. "Downloading libraries". */
  task: string;
  /** Number of files to download (0 when unknown). */
  totalFiles?: number;
  /** Files finished so far. */
  completedFiles?: number;
  /**
   * Bytes/second measured by the main process over a short sliding window.
   * Absent when the current stage has no measurable transfer (e.g. unpacking).
   */
  speedBytesPerSec?: number;
}

export interface LaunchConfig {
  version: string;
  accountId: string;
  javaPath: string;
  /** Memory in MB. */
  maxMemory: number;
  minMemory: number;
  /** Extra JVM arguments (one string, space separated is fine). */
  jvmArgs: string;
  resolution: { width: number; height: number };
  fullscreen: boolean;
}

export interface GameOutput {
  type: 'stdout' | 'stderr' | 'exit' | 'error';
  text?: string;
  code?: number;
}

// ---- crash diagnosis ----

/** One identified cause shown in the crash dialog. */
export interface CrashFinding {
  /** Stable rule id (also used to de-duplicate findings). */
  id: string;
  severity: 'error' | 'warning' | 'info';
  /** Short headline, e.g. "缺少前置模组（2 个）". */
  title: string;
  /** What it means, in plain language. May be multi-line. */
  detail: string;
  /** What the user should do about it. */
  action: string;
}

/** Everything the crash dialog needs to render and act on. */
export interface CrashInfo {
  versionId: string;
  exitCode: number | null;
  /** ISO timestamp of the failure. */
  at: string;
  /** Headline shown under the dialog title. */
  summary: string;
  findings: CrashFinding[];
  /** Package prefixes from the crash stack that do not belong to the platform. */
  suspects: string[];
  /** Number of mods loaded, when the crash report listed them. */
  modCount: number | null;
  /** `logs/latest.log` written by Minecraft, when found. */
  logPath: string | null;
  /** `crash-reports/crash-*.txt`, when Minecraft wrote one. */
  crashReportPath: string | null;
}

/** Internal shape produced by the diagnosis rules before paths are attached. */
export interface CrashDiagnosis {
  summary: string;
  findings: CrashFinding[];
  suspects: string[];
  modCount: number | null;
  exitCode: number | null;
  versionId: string;
}

/** A Minecraft character a LittleSkin account can sign in as. */
export interface LittleSkinRole {
  id: string;
  name: string;
  /** True for the character the account is currently bound to. */
  selected: boolean;
}

/** Result of a LittleSkin role detection. */
export interface LittleSkinRoles {
  roles: LittleSkinRole[];
  /**
   * True when only the current character could be determined. The Yggdrasil API
   * only returns the full list from the login response, so accounts signed in
   * before the launcher stored it must sign in once more to see every role.
   */
  needsRelogin: boolean;
}

// ---- SLATT team account (slatt.cn SSO) ----
//
// This integration is for SLATT team members only: accounts on slatt.cn can only
// be registered by team members, so a successful SSO login always means "member".
// `groupId` still distinguishes the permission group for display purposes.

/**
 * Role on the team site, derived from the account's `group_id`.
 *
 * The site's permission groups are `super_admin` (超级管理员), `captain` (主管),
 * `tech` (技术部成员) and `member` (SLATT 成员). Any other group_id — including a
 * missing one — is treated as an ordinary member.
 */
export type SlattRole = 'super_admin' | 'captain' | 'tech' | 'member';

/** A skin published to the team's public library (`GET /api/skins`). */
export interface SlattSkin {
  id: number;
  name: string;
  /** Absolute URL of the actual 64x64 Minecraft skin PNG. */
  skinUrl: string;
  /** Absolute URL of the preview image. */
  previewUrl: string;
  /** Display name of the member who uploaded it. */
  uploaderName: string;
  /** Arm width: slim (Alex) or classic (Steve). */
  model: 'classic' | 'slim';
  /** Upload timestamp as returned by the site (`YYYY-MM-DD HH:mm:ss`). */
  createdAt: string;
}

/** The signed-in SLATT team member. */
export interface SlattUser {
  uid: string;
  /** Name shown on the website — surfaced in the home-page badge. */
  username: string;
  email: string;
  /** Absolute avatar URL, or '' when the account has none. */
  avatarUrl: string;
  groupId: string;
  role: SlattRole;
  /** Human label for the badge, already prefixed: e.g. SLATT团队主管. */
  roleLabel: string;
  /** Whether the member has bound a skin of their own on the website. */
  hasSkin: boolean;
}

/** A restored or freshly created login. */
export interface SlattSession {
  user: SlattUser;
  /** Unix ms expiry of the launcher token, or null when unknown. */
  expiresAt: number | null;
}

/** Outcome of applying a library skin to a Minecraft account. */
export interface SlattApplyResult {
  accountId: string;
  accountName: string;
  skinName: string;
  /**
   * True when the skin reached Mojang and is now the account's real skin.
   * False for offline accounts (there is no account to upload to) and for a
   * Microsoft account whose upload failed and fell back to a local preview.
   */
  uploaded: boolean;
  /**
   * Set when a Microsoft upload failed but the skin was still applied locally,
   * so the UI can explain why the change is only visible inside the launcher.
   */
  uploadError?: string;
}

// ---- resource downloads (Modrinth / CurseForge: mods, packs, shaders, datapacks, modpacks) ----

/** The content categories browsable on the 资源下载 page. */
export type ResourceType = 'mod' | 'resourcepack' | 'shader' | 'datapack' | 'modpack';

/** Which site a resource is fetched from. */
export type ResourceSource = 'modrinth' | 'curseforge';

/** A searchable project of any resource type. */
export interface ResourceProject {
  /** Project id (Modrinth project id, or CurseForge mod id as a string). */
  id: string;
  /** URL slug used to build the project page URL. */
  slug: string;
  title: string;
  description: string;
  /** Primary author username (empty when the API does not report it). */
  author: string;
  iconUrl?: string;
  downloads: number;
  categories: string[];
  /** Game versions the project supports (APIs may truncate this list). */
  gameVersions: string[];
  /** Where this project was found. */
  source: ResourceSource;
  /** Direct link to the project's page on its own site. */
  pageUrl?: string;
  /**
   * Chinese name from MC百科, set only when the search keyword was Chinese and
   * this project is one of the translated hits (e.g. title "Create", titleZh
   * "机械动力"). Purely presentational.
   */
  titleZh?: string;
}

/** Search filters for the resource browser. */
export interface ResourceSearchOptions {
  /** Which site to query. Defaults to Modrinth. */
  source?: ResourceSource;
  /** Only return projects supporting this Minecraft version. */
  gameVersion?: string;
  /** Only return projects for this mod loader (mods & modpacks). */
  loader?: string;
  /**
   * Sort index. `relevance` (default) for keyword searches,
   * `downloads` for popularity-based recommendations.
   */
  sortBy?: 'relevance' | 'downloads' | 'newest' | 'updated';
  limit?: number;
  offset?: number;
}

/** Result of a resource search, including how a Chinese keyword was translated. */
export interface ResourceSearchResult {
  items: ResourceProject[];
  /**
   * The English name a Chinese keyword was translated to, when translation was
   * applied. Absent for English keywords and when no confident match was found.
   */
  translatedQuery?: string;
}

/**
 * One dependency declared by a resource version — the "前置模组" a mod needs
 * before it will load.
 *
 * Both upstream sites expose these per *file*, not per project, and only for
 * dependencies the author actually declared. A mod that silently needs something
 * and never listed it cannot be detected (this is the same limitation every
 * launcher has).
 */
export interface ResourceDependency {
  /** Project id, on the same site as the dependent. */
  projectId: string;
  /**
   * Version id when the author pinned one (Modrinth only). When absent the
   * resolver picks the newest version matching the target game version + loader.
   */
  versionId?: string;
  /** `required` = the mod will not load without it; `optional` = recommended. */
  kind: 'required' | 'optional';
}

/** A dependency after resolution: its title, the file that would be installed, and state. */
export interface ResolvedDependency extends ResourceDependency {
  /** Project title, or the project id when the lookup failed. */
  title: string;
  /** URL slug for building the project page link. */
  slug: string;
  /**
   * Every version the user may pick, best match first (same game version + loader
   * before partial matches, newest first within each group). Capped server-side.
   */
  candidates: ResourceVersion[];
  /**
   * The default choice — always `candidates[0]`, or null when nothing matches.
   * The UI lets the user override it; an override is a client-side selection so the
   * list does not have to be re-resolved.
   */
  version: ResourceVersion | null;
  /** Why no version could be chosen. Empty when `version` is set. */
  problem?: string;
  /** True when this dependency already sits in the target folder. */
  installed: boolean;
  /**
   * The jar that satisfies this dependency, when one is present.
   *
   * Filled when *any* version of the mod is installed — not just the exact file the
   * resolver picked — so the UI can say "6.0.8 is installed; installing 6.0.7 will
   * replace it" instead of pretending nothing is there.
   */
  installedFile?: { filename: string; version: string };
  /** Dependencies of this dependency (one level deeper). May be empty. */
  children: ResolvedDependency[];
}

/** A concrete downloadable version of a resource project (used for "historical versions"). */
export interface ResourceVersion {
  /** Modrinth version id. */
  id: string;
  /** Human readable version name, e.g. "Sodium 0.5.8". */
  name: string;
  versionNumber: string;
  versionType: 'release' | 'beta' | 'alpha';
  /** ISO publish timestamp. */
  datePublished: string;
  downloads: number;
  gameVersions: string[];
  loaders: string[];
  /** Primary file name (never empty). */
  filename: string;
  /** Primary file size in bytes. */
  fileSize: number;
  /** Direct download url of the primary file. */
  url: string;
  /**
   * What this specific file declares it needs. Empty/absent means "nothing
   * declared", not "nothing needed" — see ResourceDependency.
   */
  dependencies?: ResourceDependency[];
}

/** Where a resource file should be installed. */
export interface ResourceInstallTarget {
  /** Local version id whose isolated game folder receives the file. Ignored when `customDir` is set. */
  versionId: string;
  /** Absolute directory chosen manually — overrides `versionId` when set. */
  customDir?: string;
  /** Datapacks only: world folder name under `saves/`. Omit to use `<gameDir>/datapacks`. */
  worldFolder?: string;
}

/** Result of installing a single resource file. */
export interface ResourceInstallResult {
  /** Absolute path of the written file. */
  path: string;
  filename: string;
  title: string;
  versionNumber: string;
}

/** A file already present in a version's content folder. */
export interface ResourceFileInfo {
  name: string;
  size: number;
  mtimeMs: number;
}

/** Result of installing a modpack (.mrpack). */
export interface ModpackInstallResult {
  /** The newly created local version id. */
  versionId: string;
  /** How many files (mods/resource packs/…) were downloaded from the pack. */
  files: number;
}

export interface AppSettings {
  /**
   * Shared resource directory — versions/libraries/assets are downloaded here and
   * shared across all versions (they are content-addressed). This is the *active*
   * game root: new installs and the game's shared assets go here.
   */
  resourcePath: string;
  /** All known game roots that are scanned for installed versions. */
  gameDirs: string[];
  /**
   * Optional CurseForge API key (free, from console.curseforge.com).
   *
   * Empty is a fully supported state: requests then go through the MCIM mirror,
   * which needs no key. When a key is present the official API is queried first
   * (authoritative, and downloads count toward author revenue) with the mirror
   * kept as an outage fallback.
   */
  curseforgeApiKey: string;
  /** Launcher color theme id (see the 更多 page for choices). */
  theme: string;
  /** Light or dark surface palette. Defaults to dark. */
  colorMode: 'dark' | 'light';
  /** Custom launcher background image (a data URL), or '' for none. */
  backgroundImage: string;
  /** Background image opacity, 0..1. */
  backgroundOpacity: number;
  /**
   * Title bar label mode.
   *
   * `default` shows "SLCL" as the title. `custom` shows `titlebarText` instead;
   * when that text is blank there is no title at all.
   */
  titlebarMode: 'default' | 'custom';
  /** User-supplied title bar text. Only read when `titlebarMode === 'custom'`. */
  titlebarText: string;
  /**
   * Whether the launcher logo is shown in the title bar.
   *
   * Independent of `titlebarMode`/`titlebarText`: the icon can be kept while using
   * a custom title, or dropped to leave a text-only strip. With both the icon and
   * the title off the bar is empty apart from the window buttons.
   */
  titlebarIcon: boolean;
  /** Per-game-version launch overrides, keyed by version id. */
  versionOverrides: Record<string, VersionLaunchOverride>;
  /** Global default java path override; empty string means auto-detect. */
  javaPath: string;
  /**
   * Java selection mode: 'auto' picks the best-matching installed Java for the
   * launched version; 'manual' always uses `javaPath`.
   */
  javaSelection: 'auto' | 'manual';
  maxMemory: number;
  minMemory: number;
  jvmArgs: string;
  resolution: { width: number; height: number };
  fullscreen: boolean;
  accounts: AccountProfile[];
  selectedAccountId: string | null;
  /**
   * Version chosen on 主页 → 启动. Shared with 版本管理, where clicking a version
   * card sets it. `null` means "not chosen yet" (the first installed version is
   * used as a fallback).
   */
  selectedVersionId: string | null;
  /** Manually imported Java executable paths (java.exe / javaw.exe). */
  manualJavaPaths: string[];
}

export interface MicrosoftDeviceCode {
  /** The code the user must enter at the login URL. */
  userCode: string;
  /** URL to open in a browser. */
  verificationUri: string;
  /** Full message to display. */
  message: string;
  /** ms timestamp when the code expires. */
  expiresAt: number;
}

export interface LoginProgress {
  status: 'device_code' | 'waiting' | 'success' | 'error';
  deviceCode?: MicrosoftDeviceCode;
  account?: AccountProfile;
  error?: string;
}

/** Result of looking up a premium account's skin by username. */
export interface SkinLookupResult {
  /** Canonical (current) username. */
  name: string;
  /** Raw 32-char UUID (no hyphens). */
  uuid: string;
  /** Skin image as a data URL (base64 PNG). */
  skin: string;
  /** Whether the skin uses the slim (Alex) model. */
  slim: boolean;
}
