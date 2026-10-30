import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type {
  GameDirInfo,
  LocalMinecraftVersion,
  ModLoader,
  RemoteMinecraftVersion,
  ResourceFileInfo,
  ResourceDependency,
  ResourceInstallTarget,
  ResolvedDependency,
  ResourceProject,
  ResourceSource,
  ResourceType,
  ResourceVersion,
  VersionContentItem,
  VersionInstallOptions,
} from '@shared/types';
import { formatBytes, notify } from '../lib/toast';
import { cancelDownload, endDownload, failDownload, startDownload, useIsDownloading } from '../lib/download';
import { loaderLabel, tagLabel, versionTypeLabel } from '../lib/i18n';
import { confirmAction } from '../components/ConfirmDialog';
import Select from '../components/Select';

/** Tab keys: the five Modrinth resource types plus the Minecraft version installer. */
type TabKey = ResourceType | 'gameversion';

interface TabDef {
  key: TabKey;
  label: string;
  folder: string;
  placeholder: string;
  hasLoader: boolean;
}

const TABS: TabDef[] = [
  { key: 'gameversion', label: '游戏版本', folder: '', placeholder: '', hasLoader: false },
  { key: 'mod', label: '模组', folder: 'mods', placeholder: '搜索模组名称…', hasLoader: true },
  { key: 'resourcepack', label: '资源包', folder: 'resourcepacks', placeholder: '搜索资源包名称…', hasLoader: false },
  { key: 'shader', label: '光影包', folder: 'shaderpacks', placeholder: '搜索光影包名称…', hasLoader: false },
  { key: 'datapack', label: '数据包', folder: 'datapacks', placeholder: '搜索数据包名称…', hasLoader: false },
  { key: 'modpack', label: '整合包', folder: '', placeholder: '搜索整合包名称…', hasLoader: true },
];

const LOADERS = ['fabric', 'forge', 'neoforge', 'quilt'];

/** Mod loader choices offered by the vanilla/minecraft version installer. */
const VERSION_LOADER_OPTIONS: Array<{ value: ModLoader | ''; label: string }> = [
  { value: '', label: '无(原版)' },
  { value: 'fabric', label: 'Fabric' },
  { value: 'forge', label: 'Forge' },
  { value: 'neoforge', label: 'NeoForge' },
];

/** How many recommendation cards per page. */
const REC_PAGE_SIZE = 20;

/** 1.2k / 3.4M — download counter formatting (not bytes). */
/**
 * Dependencies ("前置模组") of the picked version.
 *
 * Renders nothing when the version declares none, so mods without dependencies
 * see no extra UI at all. When something is missing this is the loudest element
 * in the dialog on purpose: a mod with an unmet prerequisite simply will not load,
 * and the crash it produces gives no hint about what is missing.
 */
function DependencyPanel({
  dependencies,
  loading,
  error,
  missing,
  autoInstall,
  onToggleAutoInstall,
  onInstall,
  onOpenProject,
  installing,
  versionChoice,
  onChooseVersion,
}: {
  dependencies: ResolvedDependency[] | null;
  loading: boolean;
  error: string;
  missing: ResolvedDependency[];
  autoInstall: boolean;
  onToggleAutoInstall: (next: boolean) => void;
  onInstall: (dep: ResolvedDependency) => void;
  onOpenProject: (dep: ResolvedDependency) => void;
  installing: boolean;
  /** projectId -> version id chosen by the user (overrides the default). */
  versionChoice: Record<string, string>;
  onChooseVersion: (projectId: string, versionId: string) => void;
}): JSX.Element | null {
  const declared = dependencies ?? [];
  if (!loading && !error && declared.length === 0) return null;

  const hasMissing = missing.length > 0;

  return (
    <div className={`dep-panel${hasMissing ? ' has-required' : ''}`} style={{ marginBottom: 12 }}>
      <div className="dep-panel-head">
        <span className="dep-panel-title">
          {hasMissing ? '缺少前置模组' : '前置模组'}
        </span>
        <span className="badge dep-count-badge">{declared.length} 个</span>
      </div>

      {loading && <p className="muted small" style={{ margin: '6px 0 0' }}>正在查询前置模组…</p>}

      {error && (
        <p className="small" style={{ margin: '6px 0 0', color: 'var(--danger)' }}>
          查询前置失败：{error}
        </p>
      )}

      {!loading && declared.length > 0 && (
        <ul className="dep-list">
          {declared.map((dep) => (
            <DependencyRow
              key={dep.projectId}
              dep={dep}
              depth={0}
              installing={installing}
              onInstall={onInstall}
              onOpenProject={onOpenProject}
              versionChoice={versionChoice}
              onChooseVersion={onChooseVersion}
            />
          ))}
        </ul>
      )}

      {hasMissing && (
        <p className="dep-panel-hint">
          缺少前置时游戏会直接闪退或提示缺少模组，请务必安装。
        </p>
      )}

      {hasMissing && (
        <label className="dep-auto-row">
          <input
            type="checkbox"
            checked={autoInstall}
            onChange={(e) => onToggleAutoInstall(e.target.checked)}
          />
          安装模组时一并安装这 {missing.length} 个前置
        </label>
      )}
    </div>
  );
}

/** `6.0.8.1+build.1744-mc1.20.1 · 2026/01/25` — version + publish date, as asked. */
function dependencyVersionLabel(v: ResourceVersion): string {
  const date = formatDate(v.datePublished);
  return date ? `${v.versionNumber} · ${date}` : v.versionNumber;
}

/** One dependency, plus its own dependencies indented underneath. */
function DependencyRow({
  dep,
  depth,
  installing,
  onInstall,
  onOpenProject,
  versionChoice,
  onChooseVersion,
}: {
  dep: ResolvedDependency;
  depth: number;
  installing: boolean;
  onInstall: (dep: ResolvedDependency) => void;
  onOpenProject: (dep: ResolvedDependency) => void;
  versionChoice: Record<string, string>;
  onChooseVersion: (projectId: string, versionId: string) => void;
}): JSX.Element {
  // Only required dependencies reach this component (the resolver drops optional
  // ones), so there is no distinction to render any more.
  // A user override wins over the resolver's default.
  const chosen =
    dep.candidates.find((c) => c.id === versionChoice[dep.projectId]) ?? dep.version;
  /**
   * Three states, not two:
   *   exact   — the version shown is the one on disk
   *   replace — a different build of the same mod is on disk; installing swaps it
   *   none    — nothing installed
   *
   * The middle case is why the button used to reappear on an installed mod: the old
   * check compared file names only, so picking another version looked uninstalled.
   */
  const installedOnDisk = dep.installedFile;
  /**
   * "Same" is decided by the filename the resolver saw in *this dialog's* target
   * folder. The page-level `installed` list describes whichever version the page
   * has selected, which is not necessarily where this install will go — trusting it
   * showed "替换" even when the version on disk was the one already selected.
   */
  const isSameInstalled = Boolean(installedOnDisk && chosen && installedOnDisk.filename === chosen.filename);
  const isReplace =
    !isSameInstalled && Boolean(installedOnDisk) && Boolean(chosen);
  /** Only offer a dropdown when there is a real choice to make. */
  const canPick = dep.candidates.length > 1;
  const versionLabel = chosen
    ? `${chosen.versionNumber} · ${formatBytes(chosen.fileSize)}`
    : (dep.problem ?? '未找到可用文件');

  return (
    <>
      <li
        className={`dep-row${isSameInstalled ? ' installed' : ''}`}
        // 10px is the row's own padding (see .dep-row); the indent for nested
        // dependencies stacks on top of it. Setting only `depth * 18` here would
        // override that padding and leave the text touching the left bar.
        style={{ paddingLeft: 10 + depth * 18 }}
        title="前置模组：缺少它模组将无法加载"
      >
        <div className="dep-main">
          <div className="dep-name" title={dep.title}>
            {dep.title}
          </div>
          {installedOnDisk && (
            <div className="dep-installed-note">
              已安装 {installedOnDisk.version || installedOnDisk.filename}
              {isReplace ? ' · 将替换为下方所选版本' : ''}
            </div>
          )}
          {canPick ? (
            // Dropdown replaces the plain text only when there is more than one
            // version, so the common single-candidate case stays visually quiet.
            <div className="dep-version-pick">
              <Select
                className="select-sm dep-version-select"
                value={chosen?.id ?? ''}
                onChange={(id) => onChooseVersion(dep.projectId, id)}
                options={dep.candidates.map((c) => ({
                  value: c.id,
                  label: dependencyVersionLabel(c),
                }))}
                title={chosen ? `${versionLabel} · ${dependencyVersionLabel(chosen)}` : undefined}
              />
            </div>
          ) : (
            <div className={`dep-sub${chosen ? '' : ' missing'}`} title={versionLabel}>
              {versionLabel}
            </div>
          )}
        </div>
        {isSameInstalled ? (
          <span className="dep-state">已安装</span>
        ) : chosen ? (
          <button
            className="btn btn-sm btn-primary"
            onClick={() => onInstall(dep)}
            disabled={installing}
            title={isReplace ? `将删除已安装的 ${installedOnDisk?.filename ?? ''}` : undefined}
          >
            {isReplace ? '替换' : '安装'}
          </button>
        ) : (
          <button className="btn btn-sm" onClick={() => onOpenProject(dep)}>
            查看
          </button>
        )}
      </li>
      {dep.children.map((child) => (
        <DependencyRow
          key={child.projectId}
          dep={child}
          depth={depth + 1}
          installing={installing}
          onInstall={onInstall}
          onOpenProject={onOpenProject}
          versionChoice={versionChoice}
          onChooseVersion={onChooseVersion}
        />
      ))}
    </>
  );
}

/**
 * Number of dependencies the panel will actually list for a version.
 *
 * Mirrors the resolver's filter (required only, minus loader-bundled projects) so
 * the badge on the card and the rows in the panel always agree. Keep this in sync
 * with `AUTO_INSTALLED_PROJECTS` in `main/resources/index.ts`.
 */
const AUTO_INSTALLED_PROJECT_IDS = new Set(['P7dR8mSH', '306612']);
function countShownDependencies(deps: ResourceDependency[] | undefined): number {
  return (deps ?? []).filter(
    (d) => d.kind === 'required' && !AUTO_INSTALLED_PROJECT_IDS.has(d.projectId),
  ).length;
}

/** Flip `installed` on the resolved tree after a successful install. */
function markInstalled(list: ResolvedDependency[], projectId: string): ResolvedDependency[] {
  return list.map((dep) => ({
    ...dep,
    installed: dep.installed || dep.projectId === projectId,
    children: markInstalled(dep.children, projectId),
  }));
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

interface ResourceCardProps {
  p: ResourceProject;
  rank?: number;
  /**
   * Name to show — the Chinese name when one is known, else the English title.
   * Computed by the caller because the name arrives asynchronously.
   */
  zh: string;
  installing: boolean;
  /**
   * Whether to offer the MC百科 link. Only mods have `class/` entries there;
   * searching a modpack / resource pack / shader / datapack name returns unrelated
   * mods, so the link would be a dead end for every other category.
   */
  showMcmod: boolean;
  onInstall: (p: ResourceProject) => void;
  onOpenPage: (p: ResourceProject, site: ResourceSource) => void;
  onOpenMcmod: (title: string) => void;
}

/**
 * One resource card.
 *
 * Deliberately declared at module scope: a component defined inside `Resources`
 * gets a fresh function identity on every render, which makes React treat it as a
 * new component type and remount every card — re-running `<img>` loads and
 * flickering the list. That was tolerable when the page only re-rendered on user
 * actions, but Chinese names now stream in one at a time (~20 updates per page),
 * so remounting would repaint the whole grid twenty times.
 */
function ResourceCard({
  p,
  rank,
  zh,
  installing,
  showMcmod,
  onInstall,
  onOpenPage,
  onOpenMcmod,
}: ResourceCardProps): JSX.Element {
  const onModrinth = p.source === 'modrinth';
  const hasZh = zh !== p.title;
  return (
    <div className="card resource-card">
      <div className="resource-head">
        {p.iconUrl ? (
          <img className="resource-icon" src={p.iconUrl} alt={zh} loading="lazy" />
        ) : (
          <div className="resource-placeholder">{zh.charAt(0).toUpperCase()}</div>
        )}
        <div className="resource-meta">
          <div className="resource-title" title={hasZh ? `${zh} · ${p.title}` : p.title}>
            {rank !== undefined && <span className="rank-badge">{rank}</span>}
            {zh}
            {/* The English title stays visible as a gloss, since that is what the
                upstream sites and other players use. */}
            {hasZh && <span className="resource-title-en">{p.title}</span>}
          </div>
          <div className="resource-sub">
            {p.author ? p.author : '未知作者'} · {formatCount(p.downloads)} 次下载
            <span className={`badge source-badge ${onModrinth ? '' : 'badge-blue'}`}>
              {onModrinth ? 'Modrinth' : 'CurseForge'}
            </span>
          </div>
        </div>
      </div>
      {/* Description and chips always render so every card reserves the same
          vertical space — without this the install buttons drift out of line
          whenever a card has a shorter description or no tags. */}
      <div className="resource-desc">{p.description ?? ''}</div>
      <div className="chip-row">
        {p.categories.slice(0, 3).map((c) => (
          <span key={c} className="chip" title={c}>
            {tagLabel(c)}
          </span>
        ))}
      </div>
      <div className="source-links">
        <button
          className="link-btn"
          onClick={() => onOpenPage(p, 'modrinth')}
          title={onModrinth ? '在 Modrinth 打开原页面' : '按名称在 Modrinth 查找该资源'}
        >
          Modrinth
        </button>
        <span className="muted small">·</span>
        <button
          className="link-btn"
          onClick={() => onOpenPage(p, 'curseforge')}
          title={!onModrinth ? '在 CurseForge 打开原页面' : '按名称在 CurseForge 查找该资源'}
        >
          CurseForge
        </button>
        {/* MC百科 only indexes mods — see ResourceCardProps.showMcmod. */}
        {showMcmod && (
          <>
            <span className="muted small">·</span>
            <button
              className="link-btn"
              onClick={() => onOpenMcmod(zh)}
              title="在 MC百科 查找该模组（有对应条目时直接打开）"
            >
              MC百科
            </button>
          </>
        )}
      </div>
      <button className="btn btn-primary btn-block" onClick={() => onInstall(p)} disabled={installing}>
        安装
      </button>
    </div>
  );
}

/** Compare Minecraft version strings, newest first. */
function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split(/[.-]/);
  const pb = b.split(/[.-]/);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const na = Number.parseInt(pa[i] ?? '0', 10);
    const nb = Number.parseInt(pb[i] ?? '0', 10);
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      const sa = pa[i] ?? '';
      const sb = pb[i] ?? '';
      if (sa !== sb) return sa < sb ? 1 : -1;
      continue;
    }
    if (na !== nb) return nb - na;
  }
  return 0;
}

/**
 * Whether a token is a Minecraft version rather than a loader/platform tag.
 *
 * CurseForge's file metadata mixes both: a JEI release reports
 * `["Client","NeoForge","Server","26.1","26.1.1"]`. Listing "Client" in the
 * 游戏版本 filter (or on a version card) is nonsense, and picking it returns
 * nothing. Modrinth only ever reports real versions, so this is a no-op there.
 */
function isMinecraftVersion(value: string): boolean {
  return (
    // 1.20 / 1.20.1 / 26.1
    /^\d+(\.\d+)+$/.test(value) ||
    // 24w14a snapshot
    /^\d{2}w\d{2}[a-z]$/i.test(value) ||
    // 1.21.5-pre1 / 1.21.5-rc1
    /^\d+(\.\d+)+-(pre|rc)\d+$/i.test(value)
  );
}

/** Strip loader/platform tags from a game-version list. */
function minecraftVersionsOnly(list: readonly string[] | undefined): string[] {
  return (list ?? []).filter(isMinecraftVersion);
}

function formatDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(t).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

export default function Resources({
  onNavigate,
}: {
  onNavigate: (view: 'downloads') => void;
}): JSX.Element {
  const [tabKey, setTabKey] = useState<TabKey>('gameversion');
  const isGameTab = tabKey === 'gameversion';
  const type: ResourceType = isGameTab ? 'mod' : tabKey;
  const downloading = useIsDownloading();
  const [versions, setVersions] = useState<LocalMinecraftVersion[]>([]);
  const [versionId, setVersionId] = useState('');
  const [gameDirs, setGameDirs] = useState<GameDirInfo[]>([]);

  // ---- Minecraft version downloader (moved from the old 版本 page) ----
  const [remote, setRemote] = useState<RemoteMinecraftVersion[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteQuery, setRemoteQuery] = useState('');
  const [remoteFilter, setRemoteFilter] = useState<'all' | 'release' | 'snapshot' | 'old'>('release');
  const [gvTarget, setGvTarget] = useState<RemoteMinecraftVersion | null>(null);
  const [gvName, setGvName] = useState('');
  const [gvLoader, setGvLoader] = useState<ModLoader | ''>('');
  const [gvLoaderVersions, setGvLoaderVersions] = useState<string[]>([]);
  const [gvLoaderVersion, setGvLoaderVersion] = useState('');
  const [gvLoadingVersions, setGvLoadingVersions] = useState(false);
  const [gvNameTouched, setGvNameTouched] = useState(false);

  // search
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [results, setResults] = useState<ResourceProject[]>([]);
  /**
   * Set when a Chinese keyword was translated to an English project name, so the
   * results header can show "已译为 Create" instead of leaving the user guessing
   * why the cards are in English.
   */
  const [translatedQuery, setTranslatedQuery] = useState('');
  const [loaderFilter, setLoaderFilter] = useState('');
  const [gameVersionFilter, setGameVersionFilter] = useState('');
  /** Which site to browse. Both work without a CurseForge key (mirror fallback). */
  const [source, setSource] = useState<ResourceSource>('modrinth');

  // installed
  const [installed, setInstalled] = useState<ResourceFileInfo[]>([]);
  const [targetPath, setTargetPath] = useState('');
  const [installedLoading, setInstalledLoading] = useState(false);

  // recommendations (most downloaded projects of the active type)
  const [recs, setRecs] = useState<ResourceProject[]>([]);
  const [recsLoading, setRecsLoading] = useState(false);
  const [recPage, setRecPage] = useState(1);
  const [recHasNext, setRecHasNext] = useState(false);
  const recsRef = useRef<HTMLDivElement>(null);

  /**
   * English project title -> Chinese name, filled in for every card (not just the
   * ones a Chinese search found). Populated from the main process cache
   * immediately and then progressively as background lookups finish.
   */
  const [zhNames, setZhNames] = useState<Record<string, string>>({});

  /**
   * MC百科 only indexes mods, so Chinese names are only meaningful for the mod tab.
   * Elsewhere the map is ignored — otherwise a shader that happens to share a name
   * with a mod would inherit that mod's Chinese name, and every non-mod card would
   * queue a lookup that can never succeed.
   */
  const useZhNames = type === 'mod';

  /** Chinese name for a project, falling back to its English title. */
  const zhOf = (p: ResourceProject): string =>
    useZhNames ? (p.titleZh ?? zhNames[p.title] ?? p.title) : p.title;

  // install dialog
  const [project, setProject] = useState<ResourceProject | null>(null);
  const [dialogVersions, setDialogVersions] = useState<ResourceVersion[]>([]);
  /**
   * Minecraft versions and mod loaders the open project actually ships files for,
   * from the upstream project document.
   *
   * Both filters in the install dialog are built from this rather than from the
   * full Minecraft version list / every known loader: offering unsupported values
   * let the user pick one and end up with "没有匹配的版本" and no obvious way back.
   */
  const [dialogSupport, setDialogSupport] = useState<{ gameVersions: string[]; loaders: string[] }>(
    { gameVersions: [], loaders: [] },
  );
  const [dialogLoading, setDialogLoading] = useState(false);
  const [dialogGameVersion, setDialogGameVersion] = useState('');
  const [dialogLoader, setDialogLoader] = useState('');

  // install target controls (inside the dialog)
  const [targetMode, setTargetMode] = useState<'auto' | 'manual'>('auto');
  const [targetVersionId, setTargetVersionId] = useState('');
  const [customDir, setCustomDir] = useState('');
  const [worldFolder, setWorldFolder] = useState('');
  const [worlds, setWorlds] = useState<VersionContentItem[]>([]);
  const [dialogTargetPath, setDialogTargetPath] = useState('');

  const [installing, setInstalling] = useState(false);
  const [packName, setPackName] = useState('');
  /**
   * Version picked in the dialog. Used by every resource type now: the picker
   * became select-then-act so a dependency panel can sit under it.
   */
  const [packVersionId, setPackVersionId] = useState('');
  /**
   * Resolved dependencies of the picked version, or null while loading.
   *
   * Only the picked version is resolved (not all of them): resolution costs one
   * request per dependency, and the dialog can show dozens of versions.
   */
  const [dependencies, setDependencies] = useState<ResolvedDependency[] | null>(null);
  const [dependencyError, setDependencyError] = useState('');
  /** Auto-install the required dependencies together with the mod (on by default). */
  const [autoInstallDeps, setAutoInstallDeps] = useState(true);
  /**
   * projectId -> version id the user picked for that dependency.
   *
   * Kept here rather than mutated into `dependencies` so re-resolving (which
   * happens whenever the picked mod version changes) cannot wipe the choice of a
   * dependency the user is still looking at.
   */
  const [depVersionChoice, setDepVersionChoice] = useState<Record<string, string>>({});

  /** The version that will actually be installed for a dependency. */
  const depVersionOf = useCallback(
    (dep: ResolvedDependency): ResourceVersion | null =>
      dep.candidates.find((c) => c.id === depVersionChoice[dep.projectId]) ?? dep.version,
    [depVersionChoice],
  );

  const tab = useMemo(() => TABS.find((t) => t.key === tabKey) ?? TABS[1], [tabKey]);

  /** True when the version name typed in the install dialog collides with an installed version. */
  const nameCollides = useMemo(() => {
    const n = gvName.trim();
    return n.length > 0 && versions.some((v) => v.id === n);
  }, [gvName, versions]);

  /** Distinct Minecraft versions across installed versions (for the filter dropdown). */
  const mcVersionOptions = useMemo(() => {
    const set = new Set(versions.map((v) => v.minecraftVersion).filter(Boolean));
    return [...set].sort(compareVersionsDesc);
  }, [versions]);

  const loadLocalVersions = useCallback(async (): Promise<LocalMinecraftVersion[]> => {
    const locals = await window.slcl.versions.local();
    setVersions(locals);
    return locals;
  }, []);

  useEffect(() => {
    (async () => {
      const locals = await loadLocalVersions();
      setVersionId(locals[0]?.id ?? '');
      setGameDirs(await window.slcl.versions.gameDirs());
    })();
  }, [loadLocalVersions]);

  // Load the remote version manifest when the game-version tab is opened.
  useEffect(() => {
    if (!isGameTab || remote.length > 0) return;
    let cancelled = false;
    setRemoteLoading(true);
    (async () => {
      try {
        const list = await window.slcl.versions.remote();
        if (!cancelled) setRemote(list);
      } catch (e) {
        if (!cancelled) notify(e instanceof Error ? e.message : String(e), 'error');
      } finally {
        if (!cancelled) setRemoteLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isGameTab, remote.length]);

  async function reloadRemote(): Promise<void> {
    setRemoteLoading(true);
    try {
      setRemote(await window.slcl.versions.remote());
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setRemoteLoading(false);
    }
  }

  /** The page-level target (auto mode: the selected version's default folder). */
  const pageTarget = useMemo<ResourceInstallTarget>(() => ({ versionId }), [versionId]);

  const refreshInstalled = useCallback(async (): Promise<void> => {
    if (type === 'modpack' || isGameTab) {
      setInstalled([]);
      setTargetPath('');
      return;
    }
    setInstalledLoading(true);
    try {
      if (!versionId) {
        setInstalled([]);
        setTargetPath('');
        return;
      }
      const [list, dir] = await Promise.all([
        window.slcl.resources.installed(type, { versionId }),
        window.slcl.resources.targetDir(type, { versionId }),
      ]);
      setInstalled(list);
      setTargetPath(dir);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setInstalledLoading(false);
    }
  }, [type, versionId, isGameTab]);

  useEffect(() => {
    void refreshInstalled();
  }, [refreshInstalled]);

  // ---- Chinese names for every card ----
  //
  // Names resolved in the background arrive one at a time (mcmod allows ~1 req/s),
  // so they are merged into a map instead of rewriting the result lists.
  useEffect(() => {
    return window.slcl.resources.onZhName(({ title, zh }) => {
      setZhNames((prev) => (prev[title] === zh ? prev : { ...prev, [title]: zh }));
    });
  }, []);

  // Ask for whatever is already cached, then queue the rest. Runs whenever the
  // visible set changes (new search, new page of recommendations, tab switch).
  // Mods only: MC百科 has no entries for the other categories, so querying for them
  // would spend a request per card (1/s) to always come back empty.
  useEffect(() => {
    if (!useZhNames) return;
    const titles = [...results, ...recs].map((p) => p.title);
    if (titles.length === 0) return;
    let cancelled = false;
    void window.slcl.resources
      .zhNames(titles)
      .then((known) => {
        if (cancelled || Object.keys(known).length === 0) return;
        setZhNames((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const [title, zh] of Object.entries(known)) {
            if (next[title] !== zh) {
              next[title] = zh;
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [useZhNames, results, recs]);

  // Popularity recommendations for the active tab (independent of the search filters,
  // so every category always has content to discover). Paged 20 at a time.
  useEffect(() => {
    if (isGameTab) {
      setRecs([]);
      setRecHasNext(false);
      setRecsLoading(false);
      return;
    }
    let cancelled = false;
    setRecsLoading(true);
    setRecs([]);
    setRecHasNext(false);
    (async () => {
      try {
        const { items } = await window.slcl.resources.search(type, '', {
          source,
          sortBy: 'downloads',
          limit: REC_PAGE_SIZE,
          offset: (recPage - 1) * REC_PAGE_SIZE,
        });
        if (cancelled) return;
        setRecs(items);
        setRecHasNext(items.length === REC_PAGE_SIZE);
      } catch (e) {
        if (!cancelled) {
          setRecs([]);
          setRecHasNext(false);
          notify(e instanceof Error ? e.message : String(e), 'error');
        }
      } finally {
        if (!cancelled) setRecsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [type, recPage, isGameTab, source]);

  function goRecPage(next: number): void {
    if (next < 1 || recsLoading) return;
    if (next > recPage && !recHasNext) return;
    setRecPage(next);
    recsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---- search ----

  async function search(): Promise<void> {
    setSearching(true);
    setSearched(true);
    try {
      const { items, translatedQuery } = await window.slcl.resources.search(type, query.trim(), {
        source,
        gameVersion: gameVersionFilter || undefined,
        loader: tab.hasLoader && loaderFilter ? loaderFilter : undefined,
      });
      setResults(items);
      setTranslatedQuery(translatedQuery ?? '');
    } catch (e) {
      setResults([]);
      setTranslatedQuery('');
      notify(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setSearching(false);
    }
  }

  function switchTab(next: TabKey): void {
    setTabKey(next);
    setResults([]);
    setSearched(false);
    setQuery('');
    setTranslatedQuery('');
    setLoaderFilter('');
    setProject(null);
    setRecPage(1);
  }

  function switchSource(next: ResourceSource): void {
    setSource(next);
    setResults([]);
    setSearched(false);
    setTranslatedQuery('');
    setProject(null);
    setRecPage(1);
  }

  // ---- Minecraft version installer ----

  const remoteFiltered = useMemo(() => {
    let list = remote;
    const q = remoteQuery.trim().toLowerCase();
    if (q) list = list.filter((v) => v.id.toLowerCase().includes(q));
    if (remoteFilter === 'release') list = list.filter((v) => v.type === 'release');
    else if (remoteFilter === 'snapshot') list = list.filter((v) => v.type === 'snapshot');
    else if (remoteFilter === 'old') list = list.filter((v) => v.type !== 'release' && v.type !== 'snapshot');
    return list;
  }, [remote, remoteQuery, remoteFilter]);

  /** PCL-style version name: vanilla "1.12.2" -> "1.12.2-Forge_14.23.5.2864". */
  function pclName(mc: string, loader: ModLoader | '', version: string): string {
    if (!loader) return mc;
    const map: Record<ModLoader, string> = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' };
    return version ? `${mc}-${map[loader]}_${version}` : mc;
  }

  function openVersionInstall(v: RemoteMinecraftVersion): void {
    setGvTarget(v);
    setGvName(v.id);
    setGvLoader('');
    setGvLoaderVersions([]);
    setGvLoaderVersion('');
    setGvNameTouched(false);
  }

  /** React to a loader change: load its available versions and auto-update the name. */
  async function changeGvLoader(loader: ModLoader | ''): Promise<void> {
    setGvLoader(loader);
    setGvLoaderVersions([]);
    setGvLoaderVersion('');
    if (!gvTarget) return;
    if (!loader) {
      if (!gvNameTouched) setGvName(gvTarget.id);
      return;
    }
    setGvLoadingVersions(true);
    try {
      const list = await window.slcl.versions.loaderVersions(loader, gvTarget.id);
      setGvLoaderVersions(list);
      if (list.length > 0) {
        setGvLoaderVersion(list[0]);
        if (!gvNameTouched) setGvName(pclName(gvTarget.id, loader, list[0]));
      }
    } catch (e) {
      setGvLoaderVersions([]);
      notify(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setGvLoadingVersions(false);
    }
  }

  function changeGvLoaderVersion(version: string): void {
    setGvLoaderVersion(version);
    if (gvTarget && !gvNameTouched) setGvName(pclName(gvTarget.id, gvLoader, version));
  }

  function changeGvName(name: string): void {
    setGvName(name);
    setGvNameTouched(true);
  }

  async function confirmVersionInstall(): Promise<void> {
    if (!gvTarget) return;
    const finalName = gvName.trim();
    // Safety: refuse to install when the name collides with an existing version.
    if (finalName && versions.some((v) => v.id === finalName)) {
      notify(`版本名称「${finalName}」已存在,请修改后再安装`, 'error');
      return;
    }
    const options: VersionInstallOptions = {};
    if (finalName && finalName !== gvTarget.id) options.name = finalName;
    if (gvLoader) options.loader = gvLoader;
    if (gvLoader && gvLoaderVersion) options.loaderVersion = gvLoaderVersion;

    const id = gvTarget.id;
    setGvTarget(null);
    startDownload('install', id);
    try {
      const finalId = await window.slcl.versions.install(id, options);
      await loadLocalVersions();
      setGameDirs(await window.slcl.versions.gameDirs());
      setVersionId(finalId);
      notify(`已安装 ${finalId}`, 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('取消')) {
        cancelDownload();
        notify('已取消下载', 'info');
      } else {
        failDownload(msg);
        notify(msg, 'error');
      }
    } finally {
      endDownload();
    }
  }

  function versionTypeBadge(t: RemoteMinecraftVersion['type']): JSX.Element {
    if (t === 'release') return <span className="badge badge-accent">正式版</span>;
    if (t === 'snapshot') return <span className="badge badge-blue">快照</span>;
    return <span className="badge">旧版</span>;
  }

  // ---- install dialog ----

  /** Fetch the downloadable version history for the dialog's project. */
  const loadDialogVersions = useCallback(
    async (p: ResourceProject, gv: string, loader: string): Promise<void> => {
      setDialogLoading(true);
      try {
        const list = await window.slcl.resources.versions(type, p.id, {
          source: p.source,
          gameVersion: gv || undefined,
          loader: loader || undefined,
        });
        setDialogVersions(list);
        // Default the modpack picker to the newest version of the filtered list.
        setPackVersionId((prev) => (list.some((v) => v.id === prev) ? prev : (list[0]?.id ?? '')));
      } catch (e) {
        setDialogVersions([]);
        setPackVersionId('');
        notify(e instanceof Error ? e.message : String(e), 'error');
      } finally {
        setDialogLoading(false);
      }
    },
    [type],
  );

  /**
   * Align the mod-version filters with the game version the user chose to install
   * into. Without this, picking a target version left the list showing files for
   * every Minecraft version, and the user had to set the same filters by hand.
   */
  async function syncFiltersToTarget(project: ResourceProject, targetVid: string): Promise<void> {
    const v = versions.find((x) => x.id === targetVid);
    if (!v) return;

    // Only switch the game filter when the resource actually ships files for that
    // version — otherwise the dropdown would hold a value it does not offer, and
    // the list below would be empty with no way back except resetting by hand.
    const targetGame = v.minecraftVersion;
    const nextGame = targetGame && dialogSupportsGameVersion(targetGame) ? targetGame : '';
    // Same guard for the loader; vanilla versions have no loader at all.
    const nextLoader =
      tab.hasLoader && v.loader && dialogSupportsLoader(v.loader) ? v.loader : '';

    const gameChanged = nextGame !== dialogGameVersion;
    const loaderChanged = nextLoader !== dialogLoader;
    if (!gameChanged && !loaderChanged) return;

    setDialogGameVersion(nextGame);
    setDialogLoader(nextLoader);
    await loadDialogVersions(project, nextGame, nextLoader);
  }

  async function openDialog(p: ResourceProject): Promise<void> {
    setProject(p);
    const initialTarget = versionId || versions[0]?.id || '';
    // Page-level filters win; otherwise derive them from the version being installed
    // into, so the list opens on compatible files instead of everything.
    const targetVersion = versions.find((v) => v.id === initialTarget);
    const preferredGame = gameVersionFilter || targetVersion?.minecraftVersion || '';
    const preferredLoader =
      loaderFilter ||
      (targetVersion?.loader && LOADERS.includes(targetVersion.loader) ? targetVersion.loader : '');
    setDialogLoader('');
    setDialogVersions([]);
    setDialogSupport({ gameVersions: [], loaders: [] });
    setDialogGameVersion('');
    setPackVersionId('');
    setTargetMode('auto');
    setTargetVersionId(initialTarget);
    setCustomDir('');
    setWorldFolder('');
    // Default modpack version name: the Chinese name when one is known, since that
    // is the name the player recognises in the version list.
    setPackName(zhOf(p));
    setDialogTargetPath('');

    // Both dropdowns may only offer what this resource supports, so the project's
    // own support matrix is fetched before either default is chosen.
    setDialogLoading(true);
    let support = { gameVersions: [] as string[], loaders: [] as string[] };
    try {
      const raw = await window.slcl.resources.support(p.id, p.source);
      support = {
        gameVersions: minecraftVersionsOnly(raw.gameVersions).sort(compareVersionsDesc),
        loaders: raw.loaders.filter((l) => LOADERS.includes(l)),
      };
    } catch {
      // Best effort: without the matrix both dropdowns collapse to "全部", which is
      // exactly what the old behaviour degraded to anyway.
    }
    setDialogSupport(support);

    // Default to the version being installed into — but only when the resource
    // supports it. Otherwise fall back to 全部版本, so the list is never empty just
    // because the player runs a Minecraft version this resource never supported.
    const initialGame =
      preferredGame && support.gameVersions.includes(preferredGame) ? preferredGame : '';
    // Same rule for the loader: a Forge-only mod opened from a Fabric page must not
    // inherit the Fabric filter and show nothing.
    const initialLoader =
      tab.hasLoader && preferredLoader && support.loaders.includes(preferredLoader)
        ? preferredLoader
        : '';
    setDialogGameVersion(initialGame);
    setDialogLoader(initialLoader);

    await loadDialogVersions(p, initialGame, initialLoader);
  }

  // Worlds are only needed for datapacks (install into a specific world).
  useEffect(() => {
    if (!project || type !== 'datapack' || !targetVersionId) {
      setWorlds([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const contents = await window.slcl.versions.contents(targetVersionId);
        if (!cancelled) setWorlds(contents.saves.filter((s) => s.isDir));
      } catch {
        if (!cancelled) setWorlds([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project, type, targetVersionId]);

  /** Build the target descriptor from the dialog controls. */
  const dialogTarget = useMemo<ResourceInstallTarget>(() => {
    if (targetMode === 'manual') return { versionId: '', customDir };
    return {
      versionId: targetVersionId,
      worldFolder: type === 'datapack' && worldFolder ? worldFolder : undefined,
    };
  }, [targetMode, customDir, targetVersionId, type, worldFolder]);

  // Resolve + display the dialog's target folder.
  useEffect(() => {
    if (!project || type === 'modpack') {
      setDialogTargetPath('');
      return;
    }
    if (targetMode === 'manual' && !customDir) {
      setDialogTargetPath('');
      return;
    }
    if (targetMode === 'auto' && !targetVersionId) {
      setDialogTargetPath('');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const dir = await window.slcl.resources.targetDir(type, dialogTarget);
        if (!cancelled) setDialogTargetPath(dir);
      } catch {
        if (!cancelled) setDialogTargetPath('');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project, type, dialogTarget, targetMode, customDir, targetVersionId]);

  async function pickFolder(): Promise<void> {
    try {
      const dir = await window.slcl.selectDirectory();
      if (dir) setCustomDir(dir);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  /**
   * Install the dependency file `dep` resolves to, into the same target folder.
   *
   * Uses the normal single-file install path, so a dependency obeys exactly the
   * same mirror/fallback/rename rules as the mod the user actually clicked.
   */
  async function installDependency(dep: ResolvedDependency): Promise<void> {
    const version = depVersionOf(dep);
    if (!project || !version) return;
    setInstalling(true);
    try {
      const r = await window.slcl.resources.install(
        type,
        dep.projectId,
        version.id,
        dialogTarget,
        project.source,
      );
      notify(`已安装前置 ${dep.title} ${r.versionNumber}`, 'success');
      // Reflect "已安装" without a full re-resolve.
      setDependencies((prev) => (prev ? markInstalled(prev, dep.projectId) : prev));
      await refreshInstalled();
    } catch (e) {
      notify(`前置 ${dep.title} 安装失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setInstalling(false);
    }
  }

  /**
   * Install the picked file, plus — by default — every missing required
   * dependency. Optional ones are installed only when the user asked for them via
   * the checklist, which is why they are not part of this list.
   */
  async function installPickedVersion(): Promise<void> {
    if (!project) return;
    const v = pickedVersion;
    if (!v) {
      notify('请先选择一个版本', 'error');
      return;
    }
    if (targetMode === 'manual' && !customDir) {
      notify('请先选择安装文件夹', 'error');
      return;
    }
    if (targetMode === 'auto' && !targetVersionId) {
      notify('请先选择游戏版本', 'error');
      return;
    }

    setInstalling(true);
    try {
      // Dependencies first: if one of them fails, the mod would not run anyway, and
      // failing early avoids leaving a mod with unmet requirements behind.
      const toInstall = autoInstallDeps ? missingDependencies : [];
      const installedDepLabels: string[] = [];
      for (const dep of toInstall) {
        const version = depVersionOf(dep);
        if (!version) continue;
        try {
          const r = await window.slcl.resources.install(
            type,
            dep.projectId,
            version.id,
            dialogTarget,
            project.source,
          );
          installedDepLabels.push(`${dep.title} ${r.versionNumber}`);
        } catch (e) {
          notify(
            `前置 ${dep.title} 安装失败：${e instanceof Error ? e.message : String(e)}。` +
              '模组仍会安装，但可能无法启动。',
            'error',
          );
        }
      }

      const r = await window.slcl.resources.install(type, project.id, v.id, dialogTarget, project.source);
      const depsNote =
        installedDepLabels.length > 0 ? `，并安装了 ${installedDepLabels.length} 个前置` : '';
      notify(`已安装 ${r.title} ${r.versionNumber}${depsNote}`, 'success');
      setProject(null);
      await refreshInstalled();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setInstalling(false);
    }
  }

  /** Open a dependency's page on its own site. */
  function openDependencyPage(dep: ResolvedDependency): void {
    const site = project?.source ?? 'modrinth';
    const path = site === 'curseforge' ? 'mc-mods' : type === 'mod' ? 'mod' : type;
    void window.slcl.openExternal(`https://${site === 'curseforge' ? 'www.curseforge.com/minecraft' : 'modrinth.com'}/${path}/${dep.slug}`);
  }

  async function installPack(): Promise<void> {
    if (!project) return;
    const chosen = dialogVersions.find((v) => v.id === packVersionId) ?? dialogVersions[0];
    if (!chosen) {
      notify('请先选择整合包版本', 'error');
      return;
    }
    setInstalling(true);
    startDownload('install', packName.trim() || project.title);
    try {
      const r = await window.slcl.resources.installModpack(
        project.id,
        chosen.id,
        packName.trim() || undefined,
        project.source,
      );
      notify(`整合包已安装为版本「${r.versionId}」(${r.files} 个文件)`, 'success');
      setProject(null);
      await loadLocalVersions();
      setVersionId(r.versionId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('取消')) {
        cancelDownload();
        notify('已取消下载', 'info');
      } else {
        failDownload(msg);
        notify(msg, 'error');
      }
    } finally {
      endDownload();
      setInstalling(false);
    }
  }

  async function removeInstalled(name: string): Promise<void> {
    const ok = await confirmAction({
      title: `删除${tab.label}`,
      message: `确定要删除「${name}」吗?\n\n将从磁盘永久删除该文件,此操作不可恢复。`,
      confirmLabel: '删除文件',
    });
    if (!ok) return;
    try {
      await window.slcl.resources.remove(type, name, pageTarget);
      await refreshInstalled();
      notify('已删除', 'info');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  // ---- options inside the dialog ----

  /**
   * The game-version filter's options — only versions the project ships files for.
   *
   * Listing every Minecraft version let the user pick one with no files and land
   * on "没有匹配的版本" with no obvious way back.
   */
  // ---- dependencies of the picked version ----

  /** The version whose 下载/安装 action will run. */
  const pickedVersion = useMemo(
    () => dialogVersions.find((v) => v.id === packVersionId) ?? null,
    [dialogVersions, packVersionId],
  );

  /**
   * Resolve dependencies for the picked version.
   *
   * Runs on selection rather than for the whole list: each dependency costs a
   * request, and a project can list dozens of versions. `cancelled` guards against
   * a slow response arriving for a version the user already moved away from.
   *
   * `dialogTarget` is a dependency on purpose: "already installed?" is answered by
   * reading that folder, so switching to another game version or picking a manual
   * folder must re-resolve — otherwise the rows keep reporting the previous
   * folder's contents and the replace/install state is wrong.
   */
  useEffect(() => {
    const declared = pickedVersion?.dependencies ?? [];
    if (!pickedVersion || declared.length === 0) {
      setDependencies(null);
      setDependencyError('');
      return;
    }
    let cancelled = false;
    setDependencies(null);
    setDependencyError('');
    void (async () => {
      try {
        // Match against the picked version's own support, not the dialog filters.
        // With no local game version installed the filters are empty, and matching
        // "anything" resolved a 1.20.1 mod's dependency to a 26.4 build.
        const games = dialogGameVersion
          ? [dialogGameVersion]
          : minecraftVersionsOnly(pickedVersion.gameVersions);
        const loaderList = dialogLoader ? [dialogLoader] : pickedVersion.loaders;
        const resolved = await window.slcl.resources.dependencies(type, declared, {
          source: project?.source ?? 'modrinth',
          ...(games.length > 0 ? { gameVersions: games } : {}),
          ...(loaderList.length > 0 ? { loaders: loaderList } : {}),
          target: dialogTarget,
        });
        if (!cancelled) setDependencies(resolved);
      } catch (e) {
        if (!cancelled) {
          setDependencies([]);
          setDependencyError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pickedVersion, type, project?.source, dialogGameVersion, dialogLoader, dialogTarget]);

  /** Every dependency in the tree that still needs installing, required first. */
  const missingDependencies = useMemo(() => {
    const out: ResolvedDependency[] = [];
    const walk = (list: ResolvedDependency[]): void => {
      for (const dep of list) {
        if (!dep.installed && dep.version) out.push(dep);
        walk(dep.children);
      }
    };
    walk(dependencies ?? []);
    return out;
  }, [dependencies]);

  const dialogGameVersionOptions = useMemo(
    () => [...dialogSupport.gameVersions].sort(compareVersionsDesc),
    [dialogSupport.gameVersions],
  );

  /**
   * The loader filter's options — only loaders the project ships files for.
   *
   * Same reasoning: offering Forge for a Fabric-only mod produced an empty list.
   */
  const dialogLoaderOptions = useMemo(
    () => LOADERS.filter((l) => dialogSupport.loaders.includes(l)),
    [dialogSupport.loaders],
  );

  /** Membership test for the game versions above. */
  const dialogSupportsGameVersion = useCallback(
    (version: string): boolean =>
      version !== '' && dialogSupport.gameVersions.includes(version),
    [dialogSupport.gameVersions],
  );

  /** Membership test for the loaders above. */
  const dialogSupportsLoader = useCallback(
    (loader: string): boolean => loader !== '' && dialogSupport.loaders.includes(loader),
    [dialogSupport.loaders],
  );

  /** Open a project's page on its own site, or a search on the other site. */
  function openPage(p: ResourceProject, site: ResourceSource): void {
    const url =
      site === p.source && p.pageUrl
        ? p.pageUrl
        : site === 'curseforge'
          ? `https://www.curseforge.com/minecraft/search?search=${encodeURIComponent(p.title)}`
          : `https://modrinth.com/mods?q=${encodeURIComponent(p.title)}`;
    void window.slcl.openExternal(url);
  }

  /**
   * Open the project on MC百科.
   *
   * Resolution happens on click rather than while rendering: mcmod.cn rate-limits
   * the search page, so pre-fetching a whole page of cards would return empty
   * results for most of them. One request per click stays well inside the limit,
   * and the main process caches both hits and misses.
   */
  async function openMcmod(title: string): Promise<void> {
    try {
      const link = await window.slcl.resources.mcmod(title);
      await window.slcl.openExternal(link.url ?? link.search);
    } catch {
      await window.slcl.openExternal(`https://search.mcmod.cn/s?key=${encodeURIComponent(title)}`);
    }
  }

  return (
    <div>
      <div className="row-between" style={{ alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">资源下载</h1>
          <p className="page-subtitle">
            下载 Minecraft 游戏版本、模组、资源包、光影包、数据包与整合包,可自由选择游戏版本与安装位置。
          </p>
        </div>
        <button
          className="btn"
          onClick={() => onNavigate('downloads')}
          title="查看下载进度、速度与文件数量"
        >
          下载管理
          {downloading && <span className="dl-nav-dot" aria-label="有下载进行中" />}
        </button>
      </div>

      {/* ---- tabs ---- */}
      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`tab${tabKey === t.key ? ' active' : ''}`}
            onClick={() => switchTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {isGameTab ? (
        <>
          <div className="card">
            <div className="row-between" style={{ gap: 10, flexWrap: 'wrap' }}>
              <div className="card-title" style={{ margin: 0 }}>
                下载游戏版本
              </div>
              <span className="muted small">
                安装到:{' '}
                <code className="path-code" style={{ display: 'inline' }}>
                  {gameDirs.find((d) => d.active)?.path ?? '未设置'}
                </code>
              </span>
            </div>
            <p className="muted small" style={{ margin: '6px 0 12px' }}>
              可在「版本管理」中切换当前文件夹。点「安装」可选择加载器(原版 / Fabric / Forge / NeoForge)与版本名。
            </p>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <input
                className="input"
                value={remoteQuery}
                onChange={(e) => setRemoteQuery(e.target.value)}
                placeholder="搜索版本号…"
                style={{ flex: 1, minWidth: 220 }}
              />
              <Select
                value={remoteFilter}
                onChange={(v) => setRemoteFilter(v as typeof remoteFilter)}
                options={[
                  { value: 'release', label: '正式版' },
                  { value: 'snapshot', label: '快照' },
                  { value: 'old', label: '旧版' },
                  { value: 'all', label: '全部类型' },
                ]}
              />
            </div>

            {remoteLoading ? (
              <p className="muted small" style={{ marginTop: 14 }}>
                正在获取版本列表…
              </p>
            ) : remoteFiltered.length === 0 ? (
              <div style={{ marginTop: 14 }}>
                <p className="muted small">
                  {remote.length === 0 ? '版本列表加载失败或为空,请重试。' : '没有匹配的版本。'}
                </p>
                <button className="btn btn-sm" onClick={() => void reloadRemote()} style={{ marginTop: 8 }}>
                  重试
                </button>
              </div>
            ) : (
              <div className="version-list" style={{ marginTop: 14, maxHeight: 480 }}>
                {remoteFiltered.map((v) => (
                  <div key={v.id} className="version-row">
                    <div className="version-row-main">
                      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                        <span className="content-row-name">{v.id}</span>
                        {versionTypeBadge(v.type)}
                      </div>
                      <span className="muted small">
                        {new Date(v.releaseTime).toLocaleDateString('zh-CN')}
                      </span>
                    </div>
                    <div className="version-row-side">
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => openVersionInstall(v)}
                        disabled={downloading}
                      >
                        安装
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          {versions.length === 0 && type !== 'modpack' && (
            <p className="muted small" style={{ margin: '-4px 0 14px' }}>
              尚未安装任何游戏版本,可在「游戏版本」标签页安装;或安装时手动指定文件夹。
            </p>
          )}

      {/* ---- search ---- */}
      <div className="card">
        <div className="row-between" style={{ gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
          <div className="card-title" style={{ margin: 0 }}>
            搜索{tab.label}
          </div>
          <div className="source-switch">
            <button
              className={`source-tab${source === 'modrinth' ? ' active' : ''}`}
              onClick={() => switchSource('modrinth')}
            >
              Modrinth
            </button>
            <button
              className={`source-tab${source === 'curseforge' ? ' active' : ''}`}
              onClick={() => switchSource('curseforge')}
            >
              CurseForge
            </button>
          </div>
        </div>

        <div className="row" style={{ flexWrap: 'wrap' }}>
          <input
            className="input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tab.placeholder}
            style={{ flex: 1, minWidth: 220 }}
            onKeyDown={(e) => e.key === 'Enter' && void search()}
          />
          {tab.hasLoader && (
            <Select
              value={loaderFilter}
              onChange={setLoaderFilter}
              options={[
                { value: '', label: '全部加载器' },
                ...LOADERS.map((l) => ({ value: l, label: loaderLabel(l) })),
              ]}
            />
          )}
          <Select
            value={gameVersionFilter}
            onChange={setGameVersionFilter}
            options={[
              { value: '', label: '全部游戏版本' },
              ...mcVersionOptions.map((v) => ({ value: v, label: v })),
            ]}
          />
          <button className="btn btn-primary" onClick={() => void search()} disabled={searching}>
            {searching ? '搜索中…' : '搜索'}
          </button>
        </div>

        <div style={{ marginTop: 16 }}>
          {!searched ? (
            <p className="muted small">输入关键词搜索更多{tab.label},下方为热门推荐。</p>
          ) : searching ? (
            <p className="muted small">搜索中…</p>
          ) : results.length === 0 ? (
            <p className="muted small">
              没有找到相关资源。
              {translatedQuery
                ? `已按中文名译为「${translatedQuery}」,可试试直接搜索英文名。`
                : '可试试用英文名或更短的关键词。'}
            </p>
          ) : (
            <>
              {translatedQuery && (
                <p className="muted small" style={{ margin: '0 0 12px' }}>
                  已按 MC百科 中文名译为「{translatedQuery}」搜索。
                </p>
              )}
              <div className="grid-mods">
                {results.map((p) => (
                  <ResourceCard
                    key={p.id}
                    p={p}
                    zh={zhOf(p)}
                    installing={installing}
                    showMcmod={useZhNames}
                    onInstall={(proj) => void openDialog(proj)}
                    onOpenPage={openPage}
                    onOpenMcmod={(title) => void openMcmod(title)}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ---- recommendations (sorted by downloads, paged) ---- */}
      <div className="card" ref={recsRef}>
        <div className="row-between" style={{ gap: 10, flexWrap: 'wrap' }}>
          <div className="card-title" style={{ margin: 0 }}>
            {tab.label}热门推荐
          </div>
          <span className="badge">按下载量排序</span>
        </div>
        <div style={{ marginTop: 14 }}>
          {recsLoading ? (
            <p className="muted small">正在获取热门{tab.label}…</p>
          ) : recs.length === 0 ? (
            <p className="muted small">
              {recPage === 1 ? '暂时无法获取推荐,请稍后重试。' : '没有更多了。'}
            </p>
          ) : (
            <div className="grid-mods">
              {recs.map((p, i) => (
                <ResourceCard
                  key={p.id}
                  p={p}
                  rank={(recPage - 1) * REC_PAGE_SIZE + i + 1}
                  zh={zhOf(p)}
                  installing={installing}
                  showMcmod={useZhNames}
                  onInstall={(proj) => void openDialog(proj)}
                  onOpenPage={openPage}
                  onOpenMcmod={(title) => void openMcmod(title)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="pager">
          <button className="btn btn-sm" onClick={() => goRecPage(recPage - 1)} disabled={recPage === 1 || recsLoading}>
            上一页
          </button>
          <span className="pager-label">第 {recPage} 页</span>
          <button
            className="btn btn-sm"
            onClick={() => goRecPage(recPage + 1)}
            disabled={!recHasNext || recsLoading}
          >
            下一页
          </button>
        </div>
      </div>

      {/* ---- installed ---- */}
      {type !== 'modpack' && (
        <div className="card">
          <div className="row-between" style={{ gap: 12, flexWrap: 'wrap' }}>
            <div className="card-title" style={{ margin: 0 }}>
              已安装 {tab.label} ({installed.length})
            </div>
            <div className="row" style={{ gap: 8 }}>
              <Select
                className="select-sm"
                value={versionId}
                onChange={setVersionId}
                title="查看哪个版本的文件夹"
                placeholder="未安装版本"
                options={
                  versions.length === 0
                    ? [{ value: '', label: '未安装版本' }]
                    : versions.map((v) => ({
                        value: v.id,
                        label: `${v.id}${v.hasModLoader ? ' (Mod)' : ''}`,
                      }))
                }
              />
              <button className="btn btn-sm" onClick={() => void refreshInstalled()} disabled={installedLoading}>
                {installedLoading ? '刷新中…' : '刷新'}
              </button>
            </div>
          </div>
          <p className="path-code" style={{ margin: '8px 0 12px' }}>
            {targetPath || '—'}
          </p>
          {!versionId ? (
            <p className="muted small">请先安装并选择一个版本。</p>
          ) : installedLoading ? (
            <p className="muted small">加载中…</p>
          ) : installed.length === 0 ? (
            <p className="muted small">该文件夹中暂无{tab.label}。</p>
          ) : (
            <div className="version-list" style={{ maxHeight: 260 }}>
              {installed.map((f) => (
                <div key={f.name} className="version-row">
                  <div className="version-row-main">
                    <span className="content-row-name">{f.name}</span>
                    <span className="muted small">{formatBytes(f.size)}</span>
                  </div>
                  <button className="btn btn-danger btn-sm" onClick={() => void removeInstalled(f.name)}>
                    删除
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ---- install dialog ---- */}
      {project && (
        <div className="modal-backdrop">
          <div className="modal modal-lg">
            <div className="modal-title">
              安装 · {zhOf(project)}
              {zhOf(project) !== project.title && (
                <span className="resource-title-en">{project.title}</span>
              )}
            </div>

            <div className="modal-body">
              <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
                <div className="field" style={{ minWidth: 180 }}>
                  <label className="field-label">游戏版本筛选</label>
                  <Select
                    value={dialogGameVersion}
                    onChange={(v) => {
                      setDialogGameVersion(v);
                      void loadDialogVersions(project, v, dialogLoader);
                    }}
                    // Only the versions this resource actually supports: listing
                    // every Minecraft version let the user pick one with no files
                    // and see an empty list.
                    options={[
                      { value: '', label: '全部版本' },
                      ...dialogGameVersionOptions.map((v) => ({ value: v, label: v })),
                    ]}
                    disabled={dialogLoading && dialogGameVersionOptions.length === 0}
                  />
                </div>
                {tab.hasLoader && (
                  <div className="field" style={{ minWidth: 160 }}>
                    <label className="field-label">加载器</label>
                    <Select
                      value={dialogLoader}
                      onChange={(v) => {
                        setDialogLoader(v);
                        void loadDialogVersions(project, dialogGameVersion, v);
                      }}
                      options={[
                        { value: '', label: '全部加载器' },
                        // Only the loaders this resource supports: offering Forge
                        // for a Fabric-only mod produced an empty version list.
                        ...dialogLoaderOptions.map((l) => ({ value: l, label: loaderLabel(l) })),
                      ]}
                      disabled={dialogLoading && dialogLoaderOptions.length === 0}
                    />
                  </div>
                )}
              </div>

              {/* version history — horizontal strip so the footer stays visible */}
              <div className="field" style={{ marginBottom: 12 }}>
                <div className="row-between" style={{ marginBottom: 6 }}>
                  <label className="field-label" style={{ margin: 0 }}>
                    选择版本(共 {dialogVersions.length} 个)
                  </label>
                  {dialogVersions.length > 1 && <span className="muted small">← 左右滚动查看历史版本 →</span>}
                </div>
                {dialogLoading ? (
                  <p className="muted small">正在获取可用版本…</p>
                ) : dialogVersions.length === 0 ? (
                  <p className="muted small">没有匹配的版本,请调整筛选条件。</p>
                ) : (
<div className="version-strip">
                    {dialogVersions.map((v, index) => {
                      const isPicked = v.id === packVersionId;
                      // A mod that declares dependencies gets a marker on the card,
                      // so "there is more to install" is visible before picking. The
                      // count has to match what the panel will list — required only,
                      // and excluding the projects installed with the loader — or the
                      // two numbers disagree.
                      const depCount = countShownDependencies(v.dependencies);
                      return (
                        <div
                          key={v.id}
                          className={`version-card${isPicked ? ' picked' : ''}`}
                          onClick={() => setPackVersionId(v.id)}
                          style={{ cursor: 'pointer' }}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setPackVersionId(v.id);
                            }
                          }}
                        >
                          <div className="version-card-head">
                            <span className="version-card-num" title={`${v.versionNumber} · ${v.name}`}>
                              {v.versionNumber}
                            </span>
                            {index === 0 && <span className="badge badge-accent">最新</span>}
                          </div>
                          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                            <span
                              className={`badge${v.versionType === 'release' ? ' badge-accent' : v.versionType === 'beta' ? ' badge-blue' : ''}`}
                            >
                              {versionTypeLabel(v.versionType)}
                            </span>
                            <span className="muted small">{formatBytes(v.fileSize)}</span>
                          </div>
                          {/* CurseForge mixes loader tags into this list, so only
                              real Minecraft versions are shown. */}
                          {(() => {
                            const gvs = minecraftVersionsOnly(v.gameVersions);
                            return (
                              <div className="version-card-sub" title={gvs.join(', ')}>
                                {gvs.slice(0, 3).join(', ')}
                                {gvs.length > 3 ? ' …' : ''}
                              </div>
                            );
                          })()}
                          <div className="version-card-sub">{formatDate(v.datePublished)}</div>
                          {depCount > 0 ? (
                            <span
                              className="badge version-card-dep-badge"
                              title={`该版本需要 ${depCount} 个前置模组`}
                            >
                              前置 {depCount}
                            </span>
                          ) : (
                            <span className="badge version-card-dep-badge is-none">无前置</span>
                          )}
                          <span className={`btn btn-sm btn-block${isPicked ? ' btn-primary' : ''}`}>
                            {isPicked ? '已选择' : '选择'}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}

              </div>

              {/* ---- dependencies (前置模组) ---- */}
              <DependencyPanel
                dependencies={dependencies}
                loading={dependencies === null && (pickedVersion?.dependencies?.length ?? 0) > 0}
                error={dependencyError}
                missing={missingDependencies}
                autoInstall={autoInstallDeps}
                onToggleAutoInstall={setAutoInstallDeps}
                onInstall={(dep) => void installDependency(dep)}
                onOpenProject={openDependencyPage}
                installing={installing}
                versionChoice={depVersionChoice}
                onChooseVersion={(projectId, versionId) =>
                  setDepVersionChoice((prev) => ({ ...prev, [projectId]: versionId }))
                }
              />

              {/* install target */}
              {type === 'modpack' ? (
                <div className="target-box">
                  <div className="field">
                    <label className="field-label">整合包名称</label>
                    <input
                      className="input"
                      value={packName}
                      onChange={(e) => setPackName(e.target.value)}
                      placeholder="新版本的名称"
                    />
                  </div>
                  <p className="muted small" style={{ margin: '8px 0 0' }}>
                    将安装{' '}
                    {dialogVersions.find((v) => v.id === packVersionId)?.versionNumber ??
                      dialogVersions[0]?.versionNumber ??
                      '所选版本'}{' '}
                    对应的 Minecraft 版本与加载器,并下载全部文件。
                  </p>
                </div>
              ) : (
                <div className="target-box">
                  <div className="row" style={{ gap: 18, marginBottom: 10 }}>
                    <label className="radio-row">
                      <input
                        type="radio"
                        name="targetMode"
                        checked={targetMode === 'auto'}
                        onChange={() => setTargetMode('auto')}
                      />
                      自动(安装到游戏版本文件夹)
                    </label>
                    <label className="radio-row">
                      <input
                        type="radio"
                        name="targetMode"
                        checked={targetMode === 'manual'}
                        onChange={() => setTargetMode('manual')}
                      />
                      手动选择位置
                    </label>
                  </div>

                  {targetMode === 'auto' ? (
                    <div className="row" style={{ flexWrap: 'wrap' }}>
                      <div className="field" style={{ flex: 1, minWidth: 200 }}>
                        <label className="field-label">游戏版本</label>
                        <Select
                          value={targetVersionId}
                          onChange={(v) => {
                            setTargetVersionId(v);
                            void syncFiltersToTarget(project, v);
                          }}
                          options={
                            versions.length === 0
                              ? [{ value: '', label: '未安装版本' }]
                              : versions.map((v) => ({
                                  value: v.id,
                                  label: `${v.id}${v.hasModLoader ? ' (Mod)' : ''}`,
                                }))
                          }
                        />
                      </div>
                      {type === 'datapack' && (
                        <div className="field" style={{ flex: 1, minWidth: 200 }}>
                          <label className="field-label">存档(可选)</label>
                          <Select
                            value={worldFolder}
                            onChange={setWorldFolder}
                            options={[
                              { value: '', label: '游戏目录/datapacks' },
                              ...worlds.map((w) => ({ value: w.name, label: w.worldName ?? w.name })),
                            ]}
                          />
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="row" style={{ flexWrap: 'wrap' }}>
                      <button className="btn" onClick={() => void pickFolder()}>
                        选择文件夹
                      </button>
                      <span className={`file-pick-name${customDir ? '' : ' empty'}`}>{customDir || '未选择文件夹'}</span>
                    </div>
                  )}

                  <p className="path-code" style={{ margin: '10px 0 0' }}>
                    {dialogTargetPath || '—'}
                  </p>
                </div>
              )}
            </div>

            <div className="dialog-actions" style={{ marginTop: 16 }}>
              <button className="btn" onClick={() => setProject(null)} disabled={installing}>
                关闭
              </button>
              {type === 'modpack' ? (
                <button
                  className="btn btn-primary"
                  onClick={() => void installPack()}
                  disabled={installing || dialogVersions.length === 0}
                >
                  {installing ? '安装中…' : '安装整合包'}
                </button>
              ) : (
                <button
                  className="btn btn-primary"
                  onClick={() => void installPickedVersion()}
                  disabled={installing || !pickedVersion}
                >
                  {installing
                    ? '安装中…'
                    : missingDependencies.length > 0 && autoInstallDeps
                      ? `安装(含 ${missingDependencies.length} 个前置)`
                      : '安装'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
        </>
      )}

      {/* ---- Minecraft version install dialog ---- */}
      {gvTarget && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-title">安装游戏版本 · {gvTarget.id}</div>
            <div className="field" style={{ marginBottom: 14 }}>
              <label className="field-label">版本名称</label>
              <input
                className={`input${nameCollides ? ' input-error' : ''}`}
                value={gvName}
                onChange={(e) => changeGvName(e.target.value)}
                placeholder={gvTarget.id}
              />
              {nameCollides ? (
                <span className="small" style={{ color: 'var(--danger)' }}>
                  版本「{gvName.trim()}」已存在,请修改名称后再安装。
                </span>
              ) : (
                <span className="muted small">自定义版本名称(即版本文件夹名),选择加载器时会自动生成。</span>
              )}
            </div>
            <div className="field" style={{ marginBottom: 14 }}>
              <label className="field-label">模组加载器</label>
              <Select
                value={gvLoader}
                onChange={(v) => void changeGvLoader(v as ModLoader | '')}
                options={VERSION_LOADER_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              />
            </div>

            {gvLoader && (
              <div className="field" style={{ marginBottom: 14 }}>
                <label className="field-label">
                  加载器版本{gvLoadingVersions ? ' (加载中…)' : ` (共 ${gvLoaderVersions.length} 个)`}
                </label>
                <Select
                  value={gvLoaderVersion}
                  onChange={changeGvLoaderVersion}
                  disabled={gvLoadingVersions || gvLoaderVersions.length === 0}
                  placeholder="暂无可用版本"
                  options={
                    gvLoaderVersions.length === 0
                      ? [{ value: '', label: '暂无可用版本' }]
                      : gvLoaderVersions.map((v, i) => ({
                          value: v,
                          label: `${v}${i === 0 ? ' (最新)' : ''}`,
                        }))
                  }
                />
                <span className="muted small">最新版本排在最前,可下拉选择历史版本。</span>
              </div>
            )}

            <div className="dialog-actions">
              <button className="btn" onClick={() => setGvTarget(null)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void confirmVersionInstall()}
                disabled={nameCollides}
              >
                开始安装
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
