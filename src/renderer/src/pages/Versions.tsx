import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import type {
  GameDirInfo,
  JavaInstallation,
  LocalMinecraftVersion,
  ScreenshotInfo,
  VersionContentItem,
  VersionContents,
  VersionFolderKind,
  VersionLaunchOverride,
} from '@shared/types';
import { formatBytes, notify } from '../lib/toast';
import { cancelDownload, endDownload, failDownload, startDownload, useDownloadTarget } from '../lib/download';
import { confirmAction } from '../components/ConfirmDialog';
import Select from '../components/Select';
import VersionIcon, { versionIconKind } from '../components/VersionIcon';
import { loaderLabel } from '../lib/i18n';

type OpenSection = 'mods' | 'shaderpacks' | 'saves' | null;

function formatTime(ms: number): string {
  if (!ms) return '';
  return new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Shorten a long path for display: C:\Users\me\AppData\Roaming\.minecraft -> …\Roaming\.minecraft */
function shortPath(p: string): string {
  if (p.length <= 46) return p;
  return `…${p.slice(-45)}`;
}

/** "sodium-fabric-0.5.8.jar" / "….jar.disabled" -> readable file name. */
function displayModName(filename: string): string {
  return filename.replace(/\.jar(\.disabled)?$/i, '');
}

/** Fallback mod icon: a pixel-art "M" in the theme accent. */
function ModIcon({ src, size = 22 }: { src?: string | null; size?: number }): JSX.Element {
  if (src) {
    return <img className="mod-icon-img" src={src} alt="" width={size} height={size} draggable={false} />;
  }
  return (
    <svg
      className="mod-icon-fallback"
      viewBox="0 0 8 8"
      width={size}
      height={size}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {/* Pixel "M" on a soft accent tile. */}
      <rect width="8" height="8" fill="currentColor" opacity="0.14" />
      <rect x="1" y="1" width="1" height="6" fill="currentColor" />
      <rect x="6" y="1" width="1" height="6" fill="currentColor" />
      <rect x="2" y="2" width="1" height="1" fill="currentColor" />
      <rect x="5" y="2" width="1" height="1" fill="currentColor" />
      <rect x="3" y="3" width="2" height="1" fill="currentColor" />
      <rect x="3" y="4" width="2" height="1" fill="currentColor" />
    </svg>
  );
}

export default function Versions(): JSX.Element {
  const [local, setLocal] = useState<LocalMinecraftVersion[]>([]);
  const [gameDirs, setGameDirs] = useState<GameDirInfo[]>([]);
  const [selectedDir, setSelectedDir] = useState<string>('');
  const [loading, setLoading] = useState(true);

  // Rename modal state.
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [renameName, setRenameName] = useState('');

  // Accordion + contents state (per version).
  const [expandedVersion, setExpandedVersion] = useState<string | null>(null);
  const [openSection, setOpenSection] = useState<Record<string, OpenSection>>({});
  const [contentsCache, setContentsCache] = useState<Record<string, VersionContents>>({});
  /** Version id whose "打开文件夹" button row is unfolded. */
  const [folderBarOpen, setFolderBarOpen] = useState<string | null>(null);
  /** versionId -> filename -> icon data URL (null = mod ships no icon). */
  const [modIcons, setModIcons] = useState<Record<string, Record<string, string | null>>>({});
  /** filename currently being enabled/disabled or deleted. */
  const [busyContent, setBusyContent] = useState<string | null>(null);

  // Screenshot viewer state.
  const [shotTarget, setShotTarget] = useState<LocalMinecraftVersion | null>(null);
  const [shots, setShots] = useState<ScreenshotInfo[]>([]);
  const [shotData, setShotData] = useState<Record<string, string>>({});
  const [previewShot, setPreviewShot] = useState<{ name: string; url: string } | null>(null);

  // Per-version launch settings (启动设置) modal.
  const [launchTarget, setLaunchTarget] = useState<LocalMinecraftVersion | null>(null);
  const [ovs, setOvs] = useState<Record<string, VersionLaunchOverride>>({});
  /** Version that 主页 will launch (persisted in settings.selectedVersionId). */
  const [launchVersionId, setLaunchVersionId] = useState('');
  const [ovMemoryMode, setOvMemoryMode] = useState<'auto' | 'custom'>('auto');
  const [ovMaxMemory, setOvMaxMemory] = useState(4096);
  const [ovJavaMode, setOvJavaMode] = useState<'auto' | 'manual'>('auto');
  const [ovJavaPath, setOvJavaPath] = useState('');
  const [ovJavaList, setOvJavaList] = useState<JavaInstallation[]>([]);
  const [ovJavaListOpen, setOvJavaListOpen] = useState(false);
  const [ovRequired, setOvRequired] = useState<number | null>(null);
  const [ovGlobalMax, setOvGlobalMax] = useState(4096);
  const [ovLoading, setOvLoading] = useState(false);

  const activeTask = useDownloadTarget();
  const repairing = activeTask?.kind === 'repair' ? activeTask.id : null;

  const refreshLocal = useCallback(async (): Promise<void> => {
    setLocal(await window.slcl.versions.local());
  }, []);

  const refreshDirs = useCallback(async (): Promise<void> => {
    setGameDirs(await window.slcl.versions.gameDirs());
  }, []);

  const refreshOverrides = useCallback(async (): Promise<void> => {
    const s = await window.slcl.settings.get();
    setOvs(s.versionOverrides ?? {});
    setLaunchVersionId(s.selectedVersionId ?? '');
  }, []);

  /** Mark a version as the one 主页 will launch. */
  async function selectLaunchVersion(versionId: string): Promise<void> {
    if (launchVersionId === versionId) return;
    setLaunchVersionId(versionId);
    try {
      await window.slcl.settings.update({ selectedVersionId: versionId });
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  /**
   * Card click selects the launch version — but only on "empty" areas.
   * Clicks that land on a control (button/input/select), an expanded section, or
   * the folder bar must keep their own behaviour.
   */
  function onCardClick(e: React.MouseEvent<HTMLDivElement>, versionId: string): void {
    const target = e.target as HTMLElement;
    if (target.closest('button, a, input, select, textarea, label')) return;
    if (target.closest('.accordion-section, .folder-bar')) return;
    // Text selection (dragging across the name) should not change the version.
    if (window.getSelection()?.toString()) return;
    void selectLaunchVersion(versionId);
  }

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        await Promise.all([refreshLocal(), refreshDirs(), refreshOverrides()]);
      } catch (e) {
        notify(e instanceof Error ? e.message : String(e), 'error');
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshLocal, refreshDirs, refreshOverrides]);

  const visible = useMemo(() => {
    if (!selectedDir) return local;
    return local.filter((v) => v.dir === selectedDir);
  }, [local, selectedDir]);

  const activeDir = useMemo(() => gameDirs.find((d) => d.active)?.path ?? '', [gameDirs]);
  const selectedDirInfo = useMemo(() => gameDirs.find((d) => d.path === selectedDir), [gameDirs, selectedDir]);

  async function applyDirs(next: GameDirInfo[]): Promise<void> {
    setGameDirs(next);
    await refreshLocal();
  }

  async function addFolder(): Promise<void> {
    try {
      const next = await window.slcl.versions.addGameDir();
      await applyDirs(next);
      notify('已添加游戏文件夹', 'success');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  async function setActiveFolder(dir: string): Promise<void> {
    try {
      const next = await window.slcl.versions.setGameDir(dir);
      await applyDirs(next);
      notify('已设为当前文件夹(新安装的游戏版本会装到这里)', 'success');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  async function removeFolder(dir: string, info: GameDirInfo | undefined): Promise<void> {
    const ok = await confirmAction({
      title: '从列表中移除文件夹',
      message: `确定不再扫描「${dir}」吗?\n\n该操作只会把它从列表里移除,${info?.versionCount ?? 0} 个游戏版本及所有存档、模组文件都会保留在磁盘上,不会被删除。`,
      confirmLabel: '从列表移除',
      danger: false,
    });
    if (!ok) return;
    try {
      const next = await window.slcl.versions.removeGameDir(dir);
      await applyDirs(next);
      setSelectedDir('');
      notify('已从列表移除该文件夹', 'info');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  async function repair(id: string): Promise<void> {
    startDownload('repair', id);
    try {
      const n = await window.slcl.versions.repair(id);
      notify(n > 0 ? `已补全 ${n} 个缺失文件` : '文件完整,无需修复', 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('取消')) {
        cancelDownload();
        notify('已取消修复', 'info');
      } else {
        failDownload(msg);
        notify(msg, 'error');
      }
    } finally {
      endDownload();
    }
  }

  async function remove(v: LocalMinecraftVersion): Promise<void> {
    const ok = await confirmAction({
      title: '删除游戏版本',
      message: `确定要删除版本「${v.id}」吗?\n\n将永久删除:\n· 版本核心文件(jar / json / 库文件索引)\n· 该版本独立目录下的存档、模组、资源包、光影、截图\n\n此操作不可恢复。`,
      confirmLabel: '永久删除',
    });
    if (!ok) return;
    try {
      await window.slcl.versions.remove(v.id);
      setContentsCache((c) => {
        const next = { ...c };
        delete next[v.id];
        return next;
      });
      if (expandedVersion === v.id) setExpandedVersion(null);
      await refreshLocal();
      await refreshDirs();
      notify(`已删除 ${v.id}`, 'info');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  async function openFolder(id: string, kind: VersionFolderKind): Promise<void> {
    try {
      await window.slcl.versions.openFolder(id, kind);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  // ---- per-version launch settings ----

  async function openLaunchSettings(v: LocalMinecraftVersion): Promise<void> {
    setLaunchTarget(v);
    setOvJavaListOpen(false);
    setOvLoading(true);
    try {
      const [s, javaList, req] = await Promise.all([
        window.slcl.settings.get(),
        window.slcl.java.detect(),
        window.slcl.versions.javaRequirement(v.id),
      ]);
      const ov = s.versionOverrides?.[v.id];
      setOvs(s.versionOverrides ?? {});
      setOvGlobalMax(s.maxMemory ?? 4096);
      setOvRequired(req.requiredMajor);
      setOvJavaList(javaList);
      setOvMemoryMode(ov?.memoryMode === 'custom' ? 'custom' : 'auto');
      setOvMaxMemory(ov?.maxMemory ?? s.maxMemory ?? 4096);
      setOvJavaMode(ov?.javaMode === 'manual' ? 'manual' : 'auto');
      setOvJavaPath(ov?.javaPath ?? '');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setOvLoading(false);
    }
  }

  async function saveLaunchSettings(reset: boolean): Promise<void> {
    if (!launchTarget) return;
    const id = launchTarget.id;
    try {
      const s = await window.slcl.settings.get();
      const next: Record<string, VersionLaunchOverride> = { ...(s.versionOverrides ?? {}) };
      if (reset) {
        delete next[id];
      } else {
        next[id] = {
          memoryMode: ovMemoryMode,
          maxMemory: Math.min(Math.max(Math.round(ovMaxMemory) || 4096, 512), 65536),
          javaMode: ovJavaMode,
          javaPath: ovJavaMode === 'manual' ? ovJavaPath.trim() : '',
        };
      }
      const updated = await window.slcl.settings.update({ versionOverrides: next });
      setOvs(updated.versionOverrides ?? {});
      setLaunchTarget(null);
      notify(reset ? '已恢复默认启动设置' : '已保存该版本的启动设置', 'success');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  function openRename(v: LocalMinecraftVersion): void {
    setRenaming({ id: v.id, name: v.id });
    setRenameName(v.id);
  }

  async function confirmRename(): Promise<void> {
    if (!renaming) return;
    const newName = renameName.trim();
    if (!newName) {
      notify('请输入新名称', 'error');
      return;
    }
    try {
      await window.slcl.versions.rename(renaming.id, newName);
      await refreshLocal();
      notify(`已重命名为 ${newName}`, 'success');
      setRenaming(null);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  // ---- accordion ----

  function toggleVersion(id: string): void {
    setExpandedVersion((prev) => (prev === id ? null : id));
  }

  function toggleSection(versionId: string, section: Exclude<OpenSection, null>): void {
    setOpenSection((prev) => ({ ...prev, [versionId]: prev[versionId] === section ? null : section }));
  }

  async function loadContents(versionId: string): Promise<VersionContents> {
    if (contentsCache[versionId]) return contentsCache[versionId];
    const c = await window.slcl.versions.contents(versionId);
    setContentsCache((prev) => ({ ...prev, [versionId]: c }));
    return c;
  }

  /** Force a refresh (after enable/disable/delete). */
  async function reloadContents(versionId: string): Promise<void> {
    const c = await window.slcl.versions.contents(versionId);
    setContentsCache((prev) => ({ ...prev, [versionId]: c }));
  }

  /** Load every mod's icon once per version (cached in main, so repeat opens are free). */
  async function loadModIcons(versionId: string): Promise<void> {
    if (modIcons[versionId]) return;
    try {
      const map = await window.slcl.versions.modIcons(versionId);
      setModIcons((prev) => ({ ...prev, [versionId]: map }));
    } catch {
      setModIcons((prev) => ({ ...prev, [versionId]: {} }));
    }
  }

  /** Enable or disable a mod (renames the .jar on disk). */
  async function toggleModState(versionId: string, mod: VersionContentItem): Promise<void> {
    setBusyContent(mod.name);
    try {
      await window.slcl.versions.toggleMod(versionId, mod.name);
      await reloadContents(versionId);
      notify(mod.disabled ? `已启用 ${displayModName(mod.name)}` : `已禁用 ${displayModName(mod.name)}`, 'success');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusyContent(null);
    }
  }

  /** Delete a mod / shaderpack / save, with a two-step confirmation. */
  async function deleteContent(
    versionId: string,
    kind: 'mods' | 'shaderpacks' | 'saves',
    item: VersionContentItem,
  ): Promise<void> {
    const label =
      kind === 'mods' ? '模组' : kind === 'shaderpacks' ? '光影包' : '存档';
    const shown = kind === 'mods' ? displayModName(item.name) : kind === 'saves' ? (item.worldName ?? item.name) : item.name;
    const extra =
      kind === 'saves'
        ? '\n\n存档内的所有世界数据都会被删除,无法恢复。'
        : '';
    const ok = await confirmAction({
      title: `删除${label}`,
      message: `确定要删除${label}「${shown}」吗?\n\n将从磁盘永久删除,此操作不可恢复。${extra}`,
      confirmLabel: '永久删除',
    });
    if (!ok) return;
    setBusyContent(item.name);
    try {
      await window.slcl.versions.deleteContent(versionId, kind, item.name);
      await reloadContents(versionId);
      notify(`已删除${label}「${shown}」`, 'info');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusyContent(null);
    }
  }

  // ---- screenshots ----

  async function openScreenshots(v: LocalMinecraftVersion): Promise<void> {
    setShotTarget(v);
    setPreviewShot(null);
    setShotData({});
    try {
      const list = await window.slcl.versions.screenshots(v.id);
      setShots(list);
      // Preload all thumbnails so the grid shows images immediately.
      for (const s of list) {
        try {
          const url = await window.slcl.versions.screenshotData(v.id, s.name);
          setShotData((prev) => ({ ...prev, [s.name]: url }));
        } catch {
          /* skip individual load failures */
        }
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  async function previewScreenshot(name: string): Promise<void> {
    if (shotData[name]) {
      setPreviewShot({ name, url: shotData[name] });
      return;
    }
    try {
      const url = await window.slcl.versions.screenshotData(shotTarget!.id, name);
      setShotData((prev) => ({ ...prev, [name]: url }));
      setPreviewShot({ name, url });
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  async function copyShot(name: string): Promise<void> {
    try {
      await window.slcl.versions.copyScreenshot(shotTarget!.id, name);
      notify('截图已复制到剪贴板', 'success');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  async function deleteShot(name: string): Promise<void> {
    const ok = await confirmAction({
      title: '删除截图',
      message: `确定要删除截图「${name}」吗?此操作不可恢复。`,
      confirmLabel: '删除截图',
    });
    if (!ok) return;
    try {
      await window.slcl.versions.deleteScreenshot(shotTarget!.id, name);
      setShots((prev) => prev.filter((s) => s.name !== name));
      setShotData((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
      if (previewShot?.name === name) setPreviewShot(null);
      notify('已删除截图', 'info');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  async function openShot(name: string): Promise<void> {
    try {
      await window.slcl.versions.openScreenshot(shotTarget!.id, name);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  return (
    <div>
      <h1 className="page-title">版本管理</h1>
      <p className="page-subtitle">管理已安装的游戏版本。下载新版本请前往「资源下载 → 游戏版本」。</p>

      {/* ---- game folders ---- */}
      <div className="card">
        <div className="row-between" style={{ gap: 10, flexWrap: 'wrap' }}>
          <div className="card-title" style={{ margin: 0 }}>
            游戏文件夹
          </div>
          <button className="btn btn-sm" onClick={() => void addFolder()}>
            + 新增文件夹
          </button>
        </div>

        <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
          <Select
            value={selectedDir}
            onChange={setSelectedDir}
            style={{ flex: 1, minWidth: 280 }}
            options={[
              { value: '', label: `全部文件夹 (${local.length} 个版本)` },
              ...gameDirs.map((d) => ({
                value: d.path,
                label: `${d.path}${d.active ? ' [当前]' : ''} · ${d.versionCount} 个版本`,
              })),
            ]}
          />
          {selectedDir && (
            <>
              {selectedDir !== activeDir && (
                <button className="btn btn-sm" onClick={() => void setActiveFolder(selectedDir)}>
                  设为当前
                </button>
              )}
              <button
                className="btn btn-danger btn-sm"
                onClick={() => void removeFolder(selectedDir, selectedDirInfo)}
                disabled={gameDirs.length <= 1}
                title={gameDirs.length <= 1 ? '至少需要保留一个文件夹' : '从扫描列表中移除'}
              >
                从列表移除
              </button>
            </>
          )}
        </div>

        {selectedDir ? (
          <div className="dir-info">
            <div className="path-code">{selectedDir}</div>
            <div className="row" style={{ gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
              <span className={`badge ${selectedDirInfo?.active ? 'badge-accent' : ''}`}>
                {selectedDirInfo?.active ? '当前文件夹' : '非当前文件夹'}
              </span>
              <span className="badge">{selectedDirInfo?.versionCount ?? 0} 个游戏版本</span>
              {selectedDirInfo && !selectedDirInfo.exists && <span className="badge badge-blue">文件夹不存在</span>}
              {selectedDirInfo && !selectedDirInfo.hasVersionsDir && (
                <span className="badge badge-blue">未检测到 versions 目录</span>
              )}
            </div>
            <p className="muted small" style={{ margin: '8px 0 0' }}>
              自动扫描该文件夹下的 <code>versions/</code> 目录来识别已安装的游戏版本。新安装的版本只会写入「当前文件夹」。
            </p>
          </div>
        ) : (
          <p className="muted small" style={{ margin: '10px 0 0' }}>
            当前显示全部 {gameDirs.length} 个文件夹中的 {local.length} 个游戏版本。选择一个文件夹可单独管理。
          </p>
        )}
      </div>

      {/* ---- installed versions ---- */}
      <div className="card">
        <div className="card-title">
          已安装版本 · {selectedDirInfo ? shortPath(selectedDir) : '全部文件夹'} ({visible.length})
        </div>
        {loading ? (
          <p className="muted">加载中…</p>
        ) : visible.length === 0 ? (
          <p className="muted">
            该文件夹下没有检测到游戏版本。可前往「资源下载 → 游戏版本」安装,或用「新增文件夹」指向已有的 .minecraft 目录。
          </p>
        ) : (
          <div className="list">
            {visible.map((v) => {
              const isExpanded = expandedVersion === v.id;
              const section = openSection[v.id] ?? null;
              const contents = contentsCache[v.id];
              const kind = versionIconKind(v);
              const isLaunch = launchVersionId === v.id;
              return (
                <div
                  key={`${v.dir}::${v.id}`}
                  className={`list-item version-item${isLaunch ? ' selected' : ''}`}
                  onClick={(e) => onCardClick(e, v.id)}
                  title={isLaunch ? '当前启动版本' : '点击设为启动版本'}
                >
                  <div className="row-between version-row-head">
                    <div className="list-item-info">
                      <div className="row version-head">
                        <VersionIcon kind={kind} size={36} />
                        <div style={{ minWidth: 0 }}>
                          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                            <span className="list-item-title">{v.id}</span>
                            <span className="badge badge-blue">MC {v.minecraftVersion}</span>
                            {v.loader && <span className="badge badge-accent">{loaderLabel(v.loader)}</span>}
                            {isLaunch && <span className="badge badge-accent">启动版本</span>}
                            {ovs[v.id] && <span className="badge badge-blue">自定义启动</span>}
                          </div>
                          <div className="list-item-sub">
                            {v.type}
                            {' · '}
                            版本隔离(独立目录)
                            {!selectedDir && ` · ${shortPath(v.dir)}`}
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="row version-actions">
                      <button
                        className={`btn btn-sm${isExpanded ? ' btn-primary' : ''}`}
                        onClick={() => toggleVersion(v.id)}
                      >
                        {isExpanded ? '收起' : '管理资源'}
                      </button>
                      <button className="btn btn-sm" onClick={() => void openLaunchSettings(v)}>
                        启动设置
                      </button>
                      <button className="btn btn-sm" onClick={() => openRename(v)}>
                        重命名
                      </button>
                      <button className="btn btn-sm" onClick={() => void repair(v.id)} disabled={activeTask !== null}>
                        {repairing === v.id ? '修复中…' : '修复'}
                      </button>
                      <button className="btn btn-sm" onClick={() => void openScreenshots(v)}>
                        截图
                      </button>
                      <button className="btn btn-danger btn-sm" onClick={() => void remove(v)}>
                        删除
                      </button>
                    </div>
                  </div>

                  {/* Folder shortcuts, folded away by default to keep the row clean. */}
                  <div className="folder-bar">
                    <button
                      className="folder-bar-toggle"
                      onClick={() => setFolderBarOpen((prev) => (prev === v.id ? null : v.id))}
                      aria-expanded={folderBarOpen === v.id}
                    >
                      <span className={`chevron ${folderBarOpen === v.id ? 'open' : ''}`}>▸</span>
                      打开文件夹
                    </button>
                    {folderBarOpen === v.id && (
                      <div className="folder-bar-list">
                        <button className="btn btn-sm" onClick={() => void openFolder(v.id, 'mods')}>
                          Mod
                        </button>
                        <button className="btn btn-sm" onClick={() => void openFolder(v.id, 'resourcepacks')}>
                          资源包
                        </button>
                        <button className="btn btn-sm" onClick={() => void openFolder(v.id, 'shaderpacks')}>
                          光影
                        </button>
                        <button className="btn btn-sm" onClick={() => void openFolder(v.id, 'datapacks')}>
                          数据包
                        </button>
                        <button className="btn btn-sm" onClick={() => void openFolder(v.id, 'saves')}>
                          存档
                        </button>
                        <button className="btn btn-sm" onClick={() => void openFolder(v.id, 'version')}>
                          版本文件夹
                        </button>
                      </div>
                    )}
                  </div>

                  {isExpanded && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 }}>
                      {/* Mods */}
                      <div className="accordion-section">
                        <button
                          className="accordion-header"
                          onClick={() => {
                            toggleSection(v.id, 'mods');
                            void loadContents(v.id);
                            void loadModIcons(v.id);
                          }}
                        >
                          <span>模组 Mod</span>
                          <span className="row" style={{ gap: 8 }}>
                            <span className="muted small">
                              {contents
                                ? `${contents.mods.filter((m) => !m.disabled).length} 启用${
                                    contents.mods.some((m) => m.disabled)
                                      ? ` / ${contents.mods.filter((m) => m.disabled).length} 禁用`
                                      : ''
                                  }`
                                : ''}
                            </span>
                            <span className={`chevron ${section === 'mods' ? 'open' : ''}`}>▸</span>
                          </span>
                        </button>
                        {section === 'mods' && (
                          <div className="accordion-body">
                            {!contents ? (
                              <p className="muted small">加载中…</p>
                            ) : contents.mods.length === 0 ? (
                              <p className="muted small">暂无模组。</p>
                            ) : (
                              contents.mods.map((m) => (
                                <div key={m.name} className={`content-row mod-row${m.disabled ? ' disabled' : ''}`}>
                                  <ModIcon src={modIcons[v.id]?.[m.name] ?? null} />
                                  <span className="content-row-name" title={m.name}>
                                    {displayModName(m.name)}
                                    {m.disabled && <span className="badge" style={{ marginLeft: 8 }}>已禁用</span>}
                                  </span>
                                  <span className="content-row-meta">{formatBytes(m.size)}</span>
                                  <button
                                    className="icon-btn"
                                    title={m.disabled ? '启用该模组' : '禁用该模组'}
                                    onClick={() => void toggleModState(v.id, m)}
                                    disabled={busyContent === m.name}
                                  >
                                    {m.disabled ? '▶' : '⏸'}
                                  </button>
                                  <button
                                    className="icon-btn"
                                    title="删除该模组"
                                    style={{ color: 'var(--danger)' }}
                                    onClick={() => void deleteContent(v.id, 'mods', m)}
                                    disabled={busyContent === m.name}
                                  >
                                    ✕
                                  </button>
                                </div>
                              ))
                            )}
                          </div>
                        )}
                      </div>

                      {/* Shaderpacks */}
                      <div className="accordion-section">
                        <button
                          className="accordion-header"
                          onClick={() => {
                            toggleSection(v.id, 'shaderpacks');
                            void loadContents(v.id);
                          }}
                        >
                          <span>光影 Shaderpacks</span>
                          <span className="row" style={{ gap: 8 }}>
                            <span className="muted small">{contents ? `${contents.shaderpacks.length} 个` : ''}</span>
                            <span className={`chevron ${section === 'shaderpacks' ? 'open' : ''}`}>▸</span>
                          </span>
                        </button>
                        {section === 'shaderpacks' && (
                          <div className="accordion-body">
                            {!contents ? (
                              <p className="muted small">加载中…</p>
                            ) : contents.shaderpacks.length === 0 ? (
                              <p className="muted small">暂无光影包。</p>
                            ) : (
                              contents.shaderpacks.map((s) => (
                                <div key={s.name} className="content-row">
                                  <span className="content-row-name" title={s.name}>
                                    {s.name}
                                  </span>
                                  <span className="content-row-meta">{s.isDir ? '文件夹' : formatBytes(s.size)}</span>
                                  <button
                                    className="icon-btn"
                                    title="删除该光影包"
                                    style={{ color: 'var(--danger)' }}
                                    onClick={() => void deleteContent(v.id, 'shaderpacks', s)}
                                    disabled={busyContent === s.name}
                                  >
                                    ✕
                                  </button>
                                </div>
                              ))
                            )}
                          </div>
                        )}
                      </div>

                      {/* Saves */}
                      <div className="accordion-section">
                        <button
                          className="accordion-header"
                          onClick={() => {
                            toggleSection(v.id, 'saves');
                            void loadContents(v.id);
                          }}
                        >
                          <span>存档 Saves</span>
                          <span className="row" style={{ gap: 8 }}>
                            <span className="muted small">{contents ? `${contents.saves.length} 个` : ''}</span>
                            <span className={`chevron ${section === 'saves' ? 'open' : ''}`}>▸</span>
                          </span>
                        </button>
                        {section === 'saves' && (
                          <div className="accordion-body">
                            {!contents ? (
                              <p className="muted small">加载中…</p>
                            ) : contents.saves.length === 0 ? (
                              <p className="muted small">暂无存档。</p>
                            ) : (
                              contents.saves.map((s) => (
                                <div key={s.name} className="content-row">
                                  <span className="content-row-name" title={s.name}>
                                    {s.worldName ?? s.name}
                                  </span>
                                  <span className="content-row-meta">{formatTime(s.mtimeMs)}</span>
                                  <button
                                    className="icon-btn"
                                    title="删除该存档"
                                    style={{ color: 'var(--danger)' }}
                                    onClick={() => void deleteContent(v.id, 'saves', s)}
                                    disabled={busyContent === s.name}
                                  >
                                    ✕
                                  </button>
                                </div>
                              ))
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ---- per-version launch settings ---- */}
      {launchTarget && (
        <div className="modal-backdrop">
          <div className="modal modal-lg">
            <div className="modal-title">启动设置 · {launchTarget.id}</div>

            <div className="modal-body">
              {ovLoading ? (
                <p className="muted small">正在读取…</p>
              ) : (
                <>
                  {ovRequired !== null && (
                    <p className="muted small" style={{ margin: '0 0 14px' }}>
                      该版本需要 <span className="accent-text">Java {ovRequired}</span>
                      {ovJavaList.some((j) =>
                        // Java 8 must match exactly; newer JDKs cannot run 1.16.5 and older.
                        ovRequired <= 8 ? j.major === 8 : j.major >= ovRequired,
                      )
                        ? ' · 已检测到可用 Java'
                        : ` · 未检测到可用的 Java ${ovRequired},可在「游戏设置」中安装`}
                    </p>
                  )}

                  {/* memory */}
                  <div className="field" style={{ marginBottom: 16 }}>
                    <label className="field-label">内存分配</label>
                    <div className="row" style={{ gap: 16, marginBottom: 8 }}>
                      <label className="radio-row">
                        <input
                          type="radio"
                          name="ovMemory"
                          checked={ovMemoryMode === 'auto'}
                          onChange={() => setOvMemoryMode('auto')}
                        />
                        自动(跟随启动器设置 {ovGlobalMax} MB)
                      </label>
                      <label className="radio-row">
                        <input
                          type="radio"
                          name="ovMemory"
                          checked={ovMemoryMode === 'custom'}
                          onChange={() => setOvMemoryMode('custom')}
                        />
                        自定义
                      </label>
                    </div>
                    {ovMemoryMode === 'custom' && (
                      <div className="override-summary">
                        <div className="memory-slider-row">
                          <input
                            className="range"
                            type="range"
                            min={512}
                            max={32768}
                            step={512}
                            value={ovMaxMemory}
                            onChange={(e) => setOvMaxMemory(Number(e.target.value))}
                          />
                          <span className="memory-value">
                            {(ovMaxMemory / 1024).toFixed(1)} GB
                          </span>
                        </div>
                        <p className="muted small" style={{ margin: '8px 0 0' }}>
                          为该版本分配的最大内存:{ovMaxMemory} MB(512 MB – 32 GB)。堆内存过大会让 GC 变慢,建议不超过物理内存的一半。
                        </p>
                      </div>
                    )}
                  </div>

                  {/* java */}
                  <div className="field" style={{ marginBottom: 8 }}>
                    <label className="field-label">Java 运行时</label>
                    <div className="row" style={{ gap: 16, marginBottom: 8 }}>
                      <label className="radio-row">
                        <input
                          type="radio"
                          name="ovJava"
                          checked={ovJavaMode === 'auto'}
                          onChange={() => setOvJavaMode('auto')}
                        />
                        跟随启动器自动选择
                      </label>
                      <label className="radio-row">
                        <input
                          type="radio"
                          name="ovJava"
                          checked={ovJavaMode === 'manual'}
                          onChange={() => {
                            setOvJavaMode('manual');
                            setOvJavaListOpen(true);
                          }}
                        />
                        手动选择
                      </label>
                    </div>

                    {ovJavaMode === 'manual' && (
                      <>
                        <div className="accordion-section">
                          <button className="accordion-header" onClick={() => setOvJavaListOpen((v) => !v)}>
                            <span>
                              Java 列表 ({ovJavaList.length})
                              {ovJavaPath && (
                                <span className="muted small" style={{ marginLeft: 8 }}>
                                  已选:
                                  {ovJavaList.find((j) => j.path === ovJavaPath)?.major ?? '自定义'}
                                </span>
                              )}
                            </span>
                            <span className={`chevron ${ovJavaListOpen ? 'open' : ''}`}>▸</span>
                          </button>
                          {ovJavaListOpen && (
                            <div className="accordion-body">
                              {ovJavaList.length === 0 ? (
                                <p className="muted small" style={{ margin: 0 }}>
                                  未检测到 Java,请到「游戏设置」中安装或刷新。
                                </p>
                              ) : (
                                <div className="java-list">
                                  {ovJavaList.map((j) => {
                                    const active = ovJavaPath === j.path;
                                    return (
                                      <button
                                        key={j.path}
                                        className={`java-row${active ? ' selected' : ''}`}
                                        onClick={() => setOvJavaPath(j.path)}
                                        title={j.path}
                                      >
                                        <div className="java-row-main">
                                          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                                            <span className="badge badge-accent">Java {j.major}</span>
                                            <span className="java-version">{j.version}</span>
                                            <span className="badge">{j.is64Bit ? '64 位' : '32 位'}</span>
                                            {j.isManaged && <span className="badge badge-blue">SLCL 安装</span>}
                                            {active && <span className="badge badge-accent">已选择</span>}
                                          </div>
                                          <span className="path-code java-path">{j.path}</span>
                                        </div>
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                              <div className="row" style={{ marginTop: 10 }}>
                                <button
                                  className="btn btn-sm"
                                  onClick={async () => {
                                    setOvLoading(true);
                                    try {
                                      setOvJavaList(await window.slcl.java.detect());
                                    } finally {
                                      setOvLoading(false);
                                    }
                                  }}
                                  disabled={ovLoading}
                                >
                                  刷新
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                        <input
                          className="input"
                          style={{ marginTop: 8 }}
                          value={ovJavaPath}
                          onChange={(e) => setOvJavaPath(e.target.value)}
                          placeholder="或直接输入 java.exe / javaw.exe 完整路径"
                        />
                      </>
                    )}
                  </div>
                </>
              )}
            </div>

            <div className="dialog-actions" style={{ marginTop: 16 }}>
              <button className="btn" onClick={() => void saveLaunchSettings(true)} disabled={ovLoading}>
                恢复默认
              </button>
              <span className="spacer" />
              <button className="btn" onClick={() => setLaunchTarget(null)} disabled={ovLoading}>
                取消
              </button>
              <button className="btn btn-primary" onClick={() => void saveLaunchSettings(false)} disabled={ovLoading}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {renaming && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-title">重命名版本</div>
            <div className="field" style={{ marginBottom: 14 }}>
              <label className="field-label">新版本名称(即版本文件夹名)</label>
              <input
                className="input"
                value={renameName}
                onChange={(e) => setRenameName(e.target.value)}
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && confirmRename()}
              />
              <span className="muted small">原名称:{renaming.name}</span>
            </div>
            <div className="dialog-actions">
              <button className="btn" onClick={() => setRenaming(null)}>
                取消
              </button>
              <button className="btn btn-primary" onClick={() => void confirmRename()}>
                确认重命名
              </button>
            </div>
          </div>
        </div>
      )}

      {shotTarget && (
        <div className="modal-backdrop">
          <div className="modal screenshot-modal">
            <div className="row-between" style={{ marginBottom: 12 }}>
              <div className="modal-title" style={{ margin: 0 }}>
                截图 · {shotTarget.id}
              </div>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn" onClick={() => void openFolder(shotTarget.id, 'screenshots')}>
                  打开截图文件夹
                </button>
                <button className="btn" onClick={() => setShotTarget(null)}>
                  关闭
                </button>
              </div>
            </div>

            {shots.length === 0 ? (
              <p className="muted">暂无截图(F2 截图后会自动出现在这里)。</p>
            ) : (
              <div className="screenshot-grid">
                {shots.map((s) => (
                  <div key={s.name} className="screenshot-card">
                    <img
                      className="screenshot-thumb"
                      src={shotData[s.name] ?? undefined}
                      onClick={() => void previewScreenshot(s.name)}
                      alt={s.name}
                      title="点击预览"
                    />
                    <div className="screenshot-card-footer">
                      <span className="screenshot-card-name" title={s.name}>
                        {s.name}
                      </span>
                      <button className="icon-btn" title="复制" onClick={() => void copyShot(s.name)}>
                        ⧉
                      </button>
                      <button className="icon-btn" title="在查看器中打开" onClick={() => void openShot(s.name)}>
                        ↗
                      </button>
                      <button
                        className="icon-btn"
                        title="删除"
                        style={{ color: 'var(--danger)' }}
                        onClick={() => void deleteShot(s.name)}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {previewShot && (
        <div className="screenshot-preview-backdrop" onClick={() => setPreviewShot(null)}>
          <img
            className="screenshot-preview-img"
            src={previewShot.url}
            alt={previewShot.name}
            onClick={(e) => e.stopPropagation()}
          />
          <div className="row" style={{ gap: 10 }} onClick={(e) => e.stopPropagation()}>
            <span className="muted" style={{ color: '#fff' }}>
              {previewShot.name}
            </span>
            <button className="btn" onClick={() => void copyShot(previewShot.name)}>
              复制
            </button>
            <button className="btn" onClick={() => void openShot(previewShot.name)}>
              打开
            </button>
            <button className="btn btn-danger" onClick={() => void deleteShot(previewShot.name)}>
              删除
            </button>
            <button className="btn" onClick={() => setPreviewShot(null)}>
              关闭
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
