import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type {
  GameDirInfo,
  LocalMinecraftVersion,
  ModLoader,
  RemoteMinecraftVersion,
  ResourceFileInfo,
  ResourceInstallTarget,
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
function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
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

  // install dialog
  const [project, setProject] = useState<ResourceProject | null>(null);
  const [dialogVersions, setDialogVersions] = useState<ResourceVersion[]>([]);
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
  /** Modrinth version id selected for modpack installation (history picker). */
  const [packVersionId, setPackVersionId] = useState('');

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
        const list = await window.slcl.resources.search(type, '', {
          source,
          sortBy: 'downloads',
          limit: REC_PAGE_SIZE,
          offset: (recPage - 1) * REC_PAGE_SIZE,
        });
        if (cancelled) return;
        setRecs(list);
        setRecHasNext(list.length === REC_PAGE_SIZE);
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
      const list = await window.slcl.resources.search(type, query.trim(), {
        source,
        gameVersion: gameVersionFilter || undefined,
        loader: tab.hasLoader && loaderFilter ? loaderFilter : undefined,
      });
      setResults(list);
    } catch (e) {
      setResults([]);
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
    setLoaderFilter('');
    setProject(null);
    setRecPage(1);
  }

  function switchSource(next: ResourceSource): void {
    setSource(next);
    setResults([]);
    setSearched(false);
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

    const nextGame = v.minecraftVersion || dialogGameVersion;
    // Only mods/resources expose a loader filter; vanilla versions have no loader.
    const nextLoader =
      tab.hasLoader && v.loader && LOADERS.includes(v.loader) ? v.loader : tab.hasLoader ? '' : '';

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
    const initialGame = gameVersionFilter || targetVersion?.minecraftVersion || '';
    const initialLoader = tab.hasLoader
      ? loaderFilter ||
        (targetVersion?.loader && LOADERS.includes(targetVersion.loader) ? targetVersion.loader : '')
      : '';
    setDialogGameVersion(initialGame);
    setDialogLoader(initialLoader);
    setDialogVersions([]);
    setPackVersionId('');
    setTargetMode('auto');
    setTargetVersionId(initialTarget);
    setCustomDir('');
    setWorldFolder('');
    setPackName(p.title);
    setDialogTargetPath('');
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

  async function installVersionFile(v: ResourceVersion): Promise<void> {
    if (!project) return;
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
      const r = await window.slcl.resources.install(type, project.id, v.id, dialogTarget, project.source);
      notify(`已安装 ${r.title} ${r.versionNumber}`, 'success');
      setProject(null);
      await refreshInstalled();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setInstalling(false);
    }
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

  // ---- version options inside the dialog ----

  const dialogGameVersionOptions = useMemo(() => {
    const set = new Set<string>();
    for (const v of dialogVersions) for (const gv of v.gameVersions) set.add(gv);
    return [...set].sort(compareVersionsDesc);
  }, [dialogVersions]);

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

  function ResourceCard({ p, rank }: { p: ResourceProject; rank?: number }): JSX.Element {
    const onModrinth = p.source === 'modrinth';
    return (
      <div className="card resource-card">
        <div className="resource-head">
          {p.iconUrl ? (
            <img className="resource-icon" src={p.iconUrl} alt={p.title} loading="lazy" />
          ) : (
            <div className="resource-placeholder">{p.title.charAt(0).toUpperCase()}</div>
          )}
          <div className="resource-meta">
            <div className="resource-title" title={p.title}>
              {rank !== undefined && <span className="rank-badge">{rank}</span>}
              {p.title}
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
            onClick={() => openPage(p, 'modrinth')}
            title={onModrinth ? '在 Modrinth 打开原页面' : '按名称在 Modrinth 查找该资源'}
          >
            Modrinth
          </button>
          <span className="muted small">·</span>
          <button
            className="link-btn"
            onClick={() => openPage(p, 'curseforge')}
            title={!onModrinth ? '在 CurseForge 打开原页面' : '按名称在 CurseForge 查找该资源'}
          >
            CurseForge
          </button>
          <span className="muted small">·</span>
          <button
            className="link-btn"
            onClick={() => void openMcmod(p.title)}
            title="在 MC百科 查找该资源（有对应条目时直接打开）"
          >
            MC百科
          </button>
        </div>
        <button className="btn btn-primary btn-block" onClick={() => void openDialog(p)} disabled={installing}>
          安装
        </button>
      </div>
    );
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
            <p className="muted small">正在从 Modrinth 获取…</p>
          ) : results.length === 0 ? (
            <p className="muted small">没有找到相关资源。</p>
          ) : (
            <div className="grid-mods">
              {results.map((p) => (
                <ResourceCard key={p.id} p={p} />
              ))}
            </div>
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
                <ResourceCard key={p.id} p={p} rank={(recPage - 1) * REC_PAGE_SIZE + i + 1} />
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
            <div className="modal-title">安装 · {project.title}</div>

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
                    options={[
                      { value: '', label: '全部版本' },
                      ...Array.from(new Set([...dialogGameVersionOptions, ...mcVersionOptions]))
                        .sort(compareVersionsDesc)
                        .map((v) => ({ value: v, label: v })),
                    ]}
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
                        ...LOADERS.map((l) => ({ value: l, label: loaderLabel(l) })),
                      ]}
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
                      const isPicked = type === 'modpack' && v.id === packVersionId;
                      return (
                        <div
                          key={v.id}
                          className={`version-card${isPicked ? ' picked' : ''}`}
                          onClick={type === 'modpack' ? () => setPackVersionId(v.id) : undefined}
                          style={type === 'modpack' ? { cursor: 'pointer' } : undefined}
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
                          <div className="version-card-sub" title={v.gameVersions.join(', ')}>
                            {v.gameVersions.slice(0, 3).join(', ')}
                            {v.gameVersions.length > 3 ? ' …' : ''}
                          </div>
                          <div className="version-card-sub">{formatDate(v.datePublished)}</div>
                          {type === 'modpack' ? (
                            <span className={`btn btn-sm btn-block${isPicked ? ' btn-primary' : ''}`}>
                              {isPicked ? '已选择' : '选择'}
                            </span>
                          ) : (
                            <button
                              className="btn btn-primary btn-sm btn-block"
                              onClick={() => void installVersionFile(v)}
                              disabled={installing}
                            >
                              {installing ? '安装中…' : '下载'}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

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
              {type === 'modpack' && (
                <button
                  className="btn btn-primary"
                  onClick={() => void installPack()}
                  disabled={installing || dialogVersions.length === 0}
                >
                  {installing ? '安装中…' : '安装整合包'}
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
