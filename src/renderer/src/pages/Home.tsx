import { useEffect, useRef, useState, type JSX } from 'react';
import type { AccountProfile, AppSettings, GameOutput, LocalMinecraftVersion, MicrosoftDeviceCode } from '@shared/types';
import { notify } from '../lib/toast';
import SkinHead from '../components/SkinHead';
import Select from '../components/Select';
import VersionIcon, { versionIconKind } from '../components/VersionIcon';
import { confirmAction } from '../components/ConfirmDialog';

interface HomeProps {
  onNavigate: (view: 'versions' | 'settings') => void;
}

type MsState = 'idle' | 'waiting' | 'device_code' | 'success' | 'error';

const ACCOUNT_TYPE_LABEL: Record<AccountProfile['type'], string> = {
  offline: '离线账户',
  microsoft: 'Microsoft 正版账户',
  littleskin: 'LittleSkin 账户',
};

const ACCOUNT_TYPE_SHORT: Record<AccountProfile['type'], string> = {
  offline: '离线',
  microsoft: '正版',
  littleskin: 'LittleSkin',
};

export default function Home({ onNavigate }: HomeProps): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [accounts, setAccounts] = useState<AccountProfile[]>([]);
  const [versions, setVersions] = useState<LocalMinecraftVersion[]>([]);

  const [accountId, setAccountId] = useState<string>('');
  const [versionId, setVersionId] = useState<string>('');

  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<GameOutput[]>([]);
  /** The log panel starts collapsed: it is a debugging aid, not the main content. */
  const [logOpen, setLogOpen] = useState(false);
  const [skin, setSkin] = useState<string>('');
  const [skinLoading, setSkinLoading] = useState(false);
  const [refreshingSkin, setRefreshingSkin] = useState(false);
  const consoleRef = useRef<HTMLDivElement>(null);
  /** Latest selected version id (the launch-output effect is mount-only). */
  const versionIdRef = useRef('');
  /** Version id we already offered a Java download for (avoids duplicate prompts). */
  const javaPromptedRef = useRef('');
  /** accountId -> skin data URL. Keeps account switches instant (no IPC round-trip). */
  const skinCacheRef = useRef<Record<string, string>>({});
  /** accountId -> in-flight request, so the prefetch and the selected-account effect share one call. */
  const skinInflightRef = useRef<Record<string, Promise<string>>>({});

  /** Fetch a skin through the renderer cache, collapsing concurrent requests per account. */
  function loadSkin(id: string): Promise<string> {
    const cached = skinCacheRef.current[id];
    if (cached) return Promise.resolve(cached);
    const existing = skinInflightRef.current[id];
    if (existing) return existing;
    const req = window.slcl.accounts
      .getSkin(id)
      .then((s) => {
        skinCacheRef.current[id] = s;
        return s;
      })
      .finally(() => {
        delete skinInflightRef.current[id];
      });
    skinInflightRef.current[id] = req;
    return req;
  }

  // ---- login modal ----
  const [loginOpen, setLoginOpen] = useState(false);
  const [offlineName, setOfflineName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msState, setMsState] = useState<MsState>('idle');
  const [deviceCode, setDeviceCode] = useState<MicrosoftDeviceCode | null>(null);
  const [msError, setMsError] = useState('');
  const [lsName, setLsName] = useState('');
  const [lsPassword, setLsPassword] = useState('');
  const [lsBusy, setLsBusy] = useState(false);

  // ---- skin modal ----
  const [skinOpen, setSkinOpen] = useState(false);
  const [skinVariant, setSkinVariant] = useState<'classic' | 'slim'>('classic');
  const [pendingSkin, setPendingSkin] = useState<string | null>(null);
  const [pendingSkinName, setPendingSkinName] = useState('');
  const [searchName, setSearchName] = useState('');
  const [searching, setSearching] = useState(false);
  const [skinBusy, setSkinBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const s = await window.slcl.settings.get();
      setSettings(s);
      const accs = await window.slcl.accounts.list();
      setAccounts(accs);
      setAccountId(s.selectedAccountId ?? accs[0]?.id ?? '');
      const locals = await window.slcl.versions.local();
      setVersions(locals);
      // The launch version is shared with 版本管理 via settings; fall back to the
      // first installed version when nothing has been chosen yet.
      const chosen = s.selectedVersionId && locals.some((v) => v.id === s.selectedVersionId) ? s.selectedVersionId : '';
      const initial = chosen || locals[0]?.id || '';
      setVersionId(initial);
      if (initial && initial !== s.selectedVersionId) {
        void window.slcl.settings.update({ selectedVersionId: initial });
      }
    })();
  }, []);

  // Skin follows the selected account; the renderer-level cache makes switches instant.
  useEffect(() => {
    if (!accountId) {
      setSkin('');
      setSkinLoading(false);
      return;
    }
    const cached = skinCacheRef.current[accountId];
    if (cached) {
      setSkin(cached);
      setSkinLoading(false);
      return;
    }
    let cancelled = false;
    setSkinLoading(true);
    loadSkin(accountId)
      .then((s) => {
        if (!cancelled) setSkin(s);
      })
      .catch(() => {
        if (!cancelled) setSkin('');
      })
      .finally(() => {
        if (!cancelled) setSkinLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  // Warm the skin cache for every account in the background (one request at a time).
  useEffect(() => {
    if (accounts.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const acc of accounts) {
        if (cancelled) return;
        if (skinCacheRef.current[acc.id]) continue;
        try {
          await loadSkin(acc.id);
        } catch {
          /* prefetch is best-effort */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accounts]);

  useEffect(() => {
    const unsub = window.slcl.launch.onOutput((o) => {
      // Keep the buffer bounded: a long session can emit tens of thousands of lines.
      setLogs((prev) => {
        const next = [...prev, o];
        return next.length > 2000 ? next.slice(next.length - 2000) : next;
      });
      if (o.type === 'exit') {
        setRunning(false);
        // A non-zero exit usually means a crash — surface the log so the user can
        // see it without hunting for the toggle.
        if ((o.code ?? 0) !== 0) setLogOpen(true);
      }
      // The game can also fail *after* launch (e.g. UnsupportedClassVersionError).
      // Offer to download the matching Java in that case, too.
      if (o.type === 'stderr' && o.text?.includes('UnsupportedClassVersionError')) {
        void handleJavaCrash();
      }
    });
    return unsub;
    // handleJavaCrash reads the latest version via a ref, so this can stay mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const unsub = window.slcl.accounts.onLoginProgress((p) => {
      if (p.status === 'device_code' && p.deviceCode) {
        setDeviceCode(p.deviceCode);
        setMsState('device_code');
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    consoleRef.current?.scrollTo({ top: consoleRef.current.scrollHeight });
  }, [logs]);

  async function refreshAccounts(selectId?: string): Promise<void> {
    const accs = await window.slcl.accounts.list();
    setAccounts(accs);
    const s = await window.slcl.settings.get();
    setSettings(s);
    setAccountId(selectId ?? s.selectedAccountId ?? accs[0]?.id ?? '');
  }

  async function changeAccount(id: string): Promise<void> {
    setAccountId(id);
    await window.slcl.accounts.select(id);
  }

  async function doOfflineLogin(): Promise<void> {
    if (!offlineName.trim()) {
      notify('请输入用户名', 'error');
      return;
    }
    setBusy(true);
    try {
      const acc = await window.slcl.accounts.loginOffline(offlineName.trim());
      setOfflineName('');
      await refreshAccounts(acc.id);
      setLoginOpen(false);
      notify(`已添加离线账户 ${acc.name}`, 'success');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function doMicrosoftLogin(): Promise<void> {
    setMsState('waiting');
    setMsError('');
    setDeviceCode(null);
    try {
      const acc = await window.slcl.accounts.loginMicrosoft();
      await refreshAccounts(acc.id);
      setMsState('success');
      setLoginOpen(false);
      notify(`已登录 ${acc.name}`, 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === '已取消登录') setMsState('idle');
      else {
        setMsError(msg);
        setMsState('error');
      }
    }
  }

  async function cancelMicrosoft(): Promise<void> {
    await window.slcl.accounts.cancelMicrosoft();
    setMsState('idle');
    setDeviceCode(null);
  }

  async function doLittleSkinLogin(): Promise<void> {
    if (!lsName.trim()) {
      notify('请输入 LittleSkin 邮箱或用户名', 'error');
      return;
    }
    if (!lsPassword) {
      notify('请输入密码', 'error');
      return;
    }
    setLsBusy(true);
    try {
      const acc = await window.slcl.accounts.loginLittleSkin(lsName.trim(), lsPassword);
      setLsName('');
      setLsPassword('');
      await refreshAccounts(acc.id);
      setLoginOpen(false);
      notify(`已登录 LittleSkin 账户 ${acc.name}`, 'success');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setLsBusy(false);
    }
  }

  async function copyCode(): Promise<void> {
    if (!deviceCode) return;
    try {
      await navigator.clipboard.writeText(deviceCode.userCode);
      notify('已复制验证码', 'success');
    } catch {
      notify('复制失败,请手动输入', 'error');
    }
  }

  async function removeAccount(id: string): Promise<void> {
    const acc = accounts.find((a) => a.id === id);
    const ok = await confirmAction({
      title: '删除账户',
      message: `确定要删除账户「${acc?.name ?? id}」吗?\n\n将移除该账户的登录信息与自定义皮肤缓存,游戏存档不受影响。`,
      confirmLabel: '删除账户',
    });
    if (!ok) return;
    try {
      await window.slcl.accounts.remove(id);
      await refreshAccounts();
      notify('已删除账户', 'info');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  // ---- skin actions ----

  function onSkinFile(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.includes('png') && !file.name.toLowerCase().endsWith('.png')) {
      notify('请选择 PNG 格式的皮肤图片(64x64 或 64x32)', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setPendingSkin(reader.result as string);
      setPendingSkinName(file.name);
    };
    reader.readAsDataURL(file);
    // Allow re-picking the same file after a reset.
    e.target.value = '';
  }

  /** Force a fresh skin lookup (bypasses launcher caches and re-downloads). */
  async function refreshSkin(accountIdToRefresh: string): Promise<void> {
    if (!accountIdToRefresh || refreshingSkin) return;
    setRefreshingSkin(true);
    try {
      const before = skinCacheRef.current[accountIdToRefresh] ?? '';
      const fresh = await window.slcl.accounts.refreshSkin(accountIdToRefresh);
      skinCacheRef.current[accountIdToRefresh] = fresh;
      if (accountIdToRefresh === accountId) {
        setSkin(fresh);
        // Local (user-picked) skins are authoritative, so a refresh may legitimately be a no-op.
        if (fresh === before) notify('皮肤未变化(已是最新)', 'info');
        else notify('皮肤预览已刷新', 'success');
      } else {
        notify('皮肤预览已刷新', 'success');
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setRefreshingSkin(false);
    }
  }

  async function applyPendingSkin(): Promise<void> {
    if (!accountId || !pendingSkin) {
      notify('请先选择皮肤图片', 'error');
      return;
    }
    const b64 = pendingSkin.split(',')[1] ?? '';
    if (!b64) return;
    const acc = accounts.find((a) => a.id === accountId);
    setSkinBusy(true);
    try {
      if (acc?.type === 'microsoft') {
        try {
          await window.slcl.accounts.uploadSkin(accountId, skinVariant, b64);
          notify('皮肤已上传,进入游戏后生效', 'success');
        } catch (e) {
          await window.slcl.accounts.setLocalSkin(accountId, b64);
          notify(`已保存本地预览(上传游戏失败:${e instanceof Error ? e.message : String(e)})`, 'info');
        }
      } else {
        await window.slcl.accounts.setLocalSkin(accountId, b64);
        notify('皮肤已更新(离线账户仅启动器预览)', 'success');
      }
      skinCacheRef.current[accountId] = pendingSkin;
      setSkin(pendingSkin);
      setPendingSkin(null);
      setPendingSkinName('');
      setSkinOpen(false);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setSkinBusy(false);
    }
  }

  async function searchPremiumSkin(): Promise<void> {
    if (!accountId) return;
    if (!searchName.trim()) {
      notify('请输入正版用户名', 'error');
      return;
    }
    setSearching(true);
    try {
      const r = await window.slcl.accounts.applySkinFromUsername(accountId, searchName.trim());
      skinCacheRef.current[accountId] = r.skin;
      setSkin(r.skin);
      setPendingSkin(null);
      setPendingSkinName('');
      setSearchName('');
      setSkinOpen(false);
      notify(`已应用 ${r.name} 的皮肤${r.slim ? '(纤细模型)' : ''}`, 'success');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setSearching(false);
    }
  }

  async function resetSkin(): Promise<void> {
    if (!accountId) return;
    setSkinBusy(true);
    try {
      await window.slcl.accounts.resetSkin(accountId);
      const next = await window.slcl.accounts.getSkin(accountId);
      skinCacheRef.current[accountId] = next;
      setSkin(next);
      setPendingSkin(null);
      setPendingSkinName('');
      setSkinOpen(false);
      notify('已重置为默认皮肤', 'success');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setSkinBusy(false);
    }
  }

  // ---- launch ----

  async function play(): Promise<void> {
    if (!accountId) {
      notify('请先添加并选择一个账户', 'error');
      return;
    }
    if (!versionId) {
      notify('请先下载并选择一个版本', 'error');
      return;
    }
    versionIdRef.current = versionId;
    javaPromptedRef.current = '';
    const config = {
      version: versionId,
      accountId,
      javaPath: settings?.javaSelection === 'manual' ? settings.javaPath : '',
      maxMemory: settings?.maxMemory ?? 4096,
      minMemory: settings?.minMemory ?? 512,
      jvmArgs: settings?.jvmArgs ?? '',
      resolution: settings?.resolution ?? { width: 1280, height: 720 },
      fullscreen: settings?.fullscreen ?? false,
    };
    setRunning(true);
    setLogs([]);
    try {
      await window.slcl.launch.start(config);
    } catch (e) {
      setRunning(false);
      const msg = e instanceof Error ? e.message : String(e);
      // Java version mismatch → if no suitable runtime is installed, offer to
      // download the exact major the game needs, then retry the launch.
      if (/需要 Java \d+/.test(msg)) {
        try {
          const req = await window.slcl.versions.javaRequirement(versionId);
          if (!req.satisfied) {
            const ok = await confirmAction({
              title: '需要下载 Java',
              message:
                `版本「${versionId}」需要 Java ${req.requiredMajor},但本机没有可用的 Java ${req.requiredMajor}。\n\n` +
                `是否现在下载并安装 Adoptium Temurin Java ${req.requiredMajor}?安装完成后会自动重新启动游戏。`,
              confirmLabel: `下载 Java ${req.requiredMajor}`,
              cancelLabel: '不用了',
              danger: false,
            });
            if (ok) {
              notify(`正在下载 Java ${req.requiredMajor}…`, 'info');
              const installed = await window.slcl.java.install(req.requiredMajor);
              notify(`Java ${installed.version} 安装完成,正在重新启动游戏…`, 'success');
              await play();
              return;
            }
          }
        } catch (err) {
          notify(err instanceof Error ? err.message : String(err), 'error');
          return;
        }
      }
      notify(msg, 'error');
    }
  }

  /** Offer to install the Java a crashed launch needed (UnsupportedClassVersionError). */
  async function handleJavaCrash(): Promise<void> {
    const vid = versionIdRef.current;
    if (!vid || javaPromptedRef.current === vid) return;
    javaPromptedRef.current = vid;
    setRunning(false);
    try {
      const req = await window.slcl.versions.javaRequirement(vid);
      if (req.satisfied) {
        notify(
          `游戏因 Java 版本不兼容退出。本机已有可用的 Java ${req.bestMajor},请到「版本管理 → 启动设置」为该版本指定它。`,
          'error',
        );
        return;
      }
      const ok = await confirmAction({
        title: '需要下载 Java',
        message:
          `版本「${vid}」需要 Java ${req.requiredMajor},但本机没有可用的 Java ${req.requiredMajor}(游戏因此无法启动)。\n\n` +
          `是否现在下载并安装 Adoptium Temurin Java ${req.requiredMajor}?`,
        confirmLabel: `下载 Java ${req.requiredMajor}`,
        cancelLabel: '不用了',
        danger: false,
      });
      if (ok) {
        notify(`正在下载 Java ${req.requiredMajor}…`, 'info');
        const installed = await window.slcl.java.install(req.requiredMajor);
        javaPromptedRef.current = '';
        notify(`Java ${installed.version} 安装完成,可以再次点击「启动游戏」`, 'success');
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  const selectedAccount = accounts.find((a) => a.id === accountId);
  const selectedVersion = versions.find((v) => v.id === versionId);

  return (
    <div>
      <h1 className="page-title">主页</h1>
      <p className="page-subtitle">选择账户与版本,开始游戏。</p>

      {/* ---- Account card ---- */}
      <div className="card">
        <div className="card-title">账户</div>
        <div className="account-row">
          <div className="skin-avatar-wrap">
            <button
              className="skin-avatar"
              onClick={() => accountId && setSkinOpen(true)}
              title={accountId ? '点击更换皮肤' : '请先添加账户'}
            >
              {accountId ? <SkinHead skin={skin} size={64} /> : <span className="skin-avatar-empty">?</span>}
              {skinLoading && accountId && <span className="skin-avatar-loading" />}
            </button>
            {accountId && (
              <button
                className={`skin-refresh${refreshingSkin ? ' spinning' : ''}`}
                onClick={() => refreshSkin(accountId)}
                disabled={refreshingSkin}
                title="刷新皮肤预览"
                aria-label="刷新皮肤预览"
              >
                ⟳
              </button>
            )}
          </div>

          <div className="account-meta">
            <div className="account-name">{selectedAccount?.name ?? '未选择账户'}</div>
            <div className="account-sub">
              {selectedAccount ? ACCOUNT_TYPE_LABEL[selectedAccount.type] : '请添加或选择一个账户'}
            </div>
          </div>

          <span className="spacer" />

          <div className="row" style={{ gap: 8 }}>
            <Select
              value={accountId}
              onChange={(v) => void changeAccount(v)}
              style={{ minWidth: 200 }}
              options={
                accounts.length === 0
                  ? [{ value: '', label: '无账户' }]
                  : accounts.map((a) => ({ value: a.id, label: `${a.name} (${ACCOUNT_TYPE_SHORT[a.type]})` }))
              }
            />
            <button className="btn btn-primary" onClick={() => setLoginOpen(true)}>
              添加账户
            </button>
            {selectedAccount && (
              <button className="btn btn-danger" onClick={() => removeAccount(selectedAccount.id)}>
                删除
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ---- Launch card ---- */}
      <div className="card">
        <div className="card-title">启动</div>
        <div className="launch-row">
          <button
            className="btn btn-lg launch-pick"
            onClick={() => onNavigate('versions')}
            title="前往版本管理选择要启动的版本"
            disabled={running}
          >
            {selectedVersion ? (
              <>
                <VersionIcon kind={versionIconKind(selectedVersion)} size={24} />
                <span className="launch-pick-text">
                  <span className="launch-pick-name">{selectedVersion.id}</span>
                  <span className="launch-pick-meta">MC {selectedVersion.minecraftVersion}</span>
                </span>
              </>
            ) : (
              <span className="launch-pick-text">
                <span className="launch-pick-name">选择版本</span>
                <span className="launch-pick-meta">尚未安装任何版本</span>
              </span>
            )}
            <span className="launch-pick-arrow" aria-hidden="true">
              ›
            </span>
          </button>

          <button className="btn btn-primary btn-lg launch-play" onClick={play} disabled={running}>
            {running ? '游戏运行中…' : '启动游戏'}
          </button>
          {running && (
            <button className="btn btn-danger btn-lg" onClick={() => window.slcl.launch.kill()}>
              结束游戏
            </button>
          )}
        </div>
        {selectedVersion ? (
          <p className="muted small" style={{ margin: '10px 0 0' }}>
            版本隔离已开启(独立存档/模组目录)
          </p>
        ) : (
          <p className="muted small" style={{ margin: '10px 0 0' }}>
            请先到「资源下载 → 游戏版本」安装一个版本。
          </p>
        )}
        <p className="muted small" style={{ margin: '6px 0 0' }}>
          Java、内存、分辨率等启动参数请在「游戏设置」中配置。
        </p>
      </div>

      {/* ---- Logs (collapsed by default; expands on demand) ---- */}
      <div className="card log-card">
        <button
          className="log-header"
          onClick={() => setLogOpen((v) => !v)}
          aria-expanded={logOpen}
        >
          <span className="log-header-left">
            <span className={`chevron${logOpen ? ' open' : ''}`} aria-hidden="true">
              ▸
            </span>
            游戏日志
          </span>
          <span className="muted small">
            {logs.length === 0 ? '尚无输出' : logOpen ? '收起' : '展开'}
          </span>
        </button>

        {logOpen && (
          <>
            <div className="row-between log-toolbar">
              <span className="muted small">启动游戏后这里会显示实时输出。</span>
              <button className="btn btn-sm" onClick={() => setLogs([])} disabled={logs.length === 0}>
                清空
              </button>
            </div>
            <div className="console" ref={consoleRef} style={{ marginTop: 8 }}>
              {logs.length === 0 && <span className="muted">启动游戏后这里会显示日志输出…</span>}
              {logs.map((o, i) => (
                <div key={i} className={`console-line ${o.type}`}>
                  {o.type === 'exit'
                    ? // Negative codes come from the launcher itself (process never
                      // spawned), not from the game, so don't pretend it "exited".
                      o.code !== undefined && o.code < 0
                      ? '[游戏未能启动]'
                      : `[游戏已退出, code=${o.code}]`
                    : o.text ?? ''}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {(accounts.length === 0 || versions.length === 0) && (
        <div className="card" style={{ borderColor: 'var(--accent)' }}>
          <div className="row-between">
            <div>
              <div className="card-title" style={{ margin: 0 }}>
                快速开始
              </div>
              <p className="muted small" style={{ margin: '6px 0 0' }}>
                {accounts.length === 0 && '还没有账户,'}
                {versions.length === 0 && '还没有安装版本。'}
              </p>
            </div>
            <div className="row">
              {accounts.length === 0 && (
                <button className="btn btn-primary" onClick={() => setLoginOpen(true)}>
                  添加账户
                </button>
              )}
              {versions.length === 0 && (
                <button className="btn btn-primary" onClick={() => onNavigate('versions')}>
                  去下载版本
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ---- Login modal ---- */}
      {loginOpen && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-title">添加账户</div>

            {msState === 'idle' || msState === 'success' ? (
              <div>
                <div className="row" style={{ marginBottom: 14 }}>
                  <div className="field" style={{ flex: 1 }}>
                    <label className="field-label">离线用户名</label>
                    <input
                      className="input"
                      value={offlineName}
                      onChange={(e) => setOfflineName(e.target.value)}
                      placeholder="例如 Steve"
                      onKeyDown={(e) => e.key === 'Enter' && doOfflineLogin()}
                    />
                  </div>
                  <button className="btn" style={{ marginTop: 18 }} onClick={doOfflineLogin} disabled={busy}>
                    添加离线账户
                  </button>
                </div>
                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
                  <button className="btn btn-primary btn-block" onClick={doMicrosoftLogin}>
                    Microsoft 正版登录
                  </button>
                  <p className="muted small" style={{ margin: '8px 0 0' }}>
                    将打开设备码验证流程,需在浏览器输入验证码。
                  </p>
                </div>

                {/* LittleSkin — third-party Yggdrasil skin site */}
                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginTop: 14 }}>
                  <div className="field-label" style={{ marginBottom: 8 }}>
                    LittleSkin 登录
                  </div>
                  <div className="field" style={{ marginBottom: 8 }}>
                    <input
                      className="input"
                      value={lsName}
                      onChange={(e) => setLsName(e.target.value)}
                      placeholder="LittleSkin 邮箱或用户名"
                      autoComplete="username"
                    />
                  </div>
                  <div className="field" style={{ marginBottom: 8 }}>
                    <input
                      className="input"
                      type="password"
                      value={lsPassword}
                      onChange={(e) => setLsPassword(e.target.value)}
                      placeholder="密码"
                      autoComplete="current-password"
                      onKeyDown={(e) => e.key === 'Enter' && doLittleSkinLogin()}
                    />
                  </div>
                  <button className="btn btn-block" onClick={doLittleSkinLogin} disabled={lsBusy}>
                    {lsBusy ? '登录中…' : '登录 LittleSkin'}
                  </button>
                  <p className="muted small" style={{ margin: '8px 0 0' }}>
                    使用 littleskin.cn 账户登录,皮肤通过 authlib-injector 自动加载。
                    <button
                      className="link-btn"
                      onClick={() => window.slcl.openExternal('https://littleskin.cn/auth/register')}
                    >
                      没有账户?去注册
                    </button>
                  </p>
                </div>
                <div className="row" style={{ justifyContent: 'flex-end', marginTop: 20 }}>
                  <button className="btn" onClick={() => setLoginOpen(false)}>
                    关闭
                  </button>
                </div>
              </div>
            ) : (
              <div>
                {msState === 'waiting' && <p className="muted">正在获取登录验证码…</p>}
                {msState === 'device_code' && deviceCode && (
                  <div>
                    <p className="muted" style={{ margin: '0 0 4px' }}>
                      请在浏览器中打开以下链接并输入验证码:
                    </p>
                    <div className="device-code">{deviceCode.userCode}</div>
                    <div className="row" style={{ justifyContent: 'center' }}>
                      <button className="btn btn-primary" onClick={() => window.slcl.openExternal(deviceCode.verificationUri)}>
                        打开登录页面
                      </button>
                      <button className="btn" onClick={copyCode}>
                        复制验证码
                      </button>
                    </div>
                    <p className="muted small" style={{ textAlign: 'center', marginTop: 12 }}>
                      {deviceCode.verificationUri}
                    </p>
                  </div>
                )}
                {msState === 'error' && <p style={{ color: 'var(--danger)' }}>{msError}</p>}
                <div className="row" style={{ justifyContent: 'flex-end', marginTop: 20 }}>
                  <button className="btn" onClick={cancelMicrosoft}>
                    取消
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ---- Skin modal ---- */}
      {skinOpen && accountId && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-title">更换皮肤 · {selectedAccount?.name}</div>

            <div style={{ textAlign: 'center', marginBottom: 16 }}>
              <div className="skin-preview-box">
                <SkinHead skin={pendingSkin ?? skin} size={128} />
                {skinLoading && !pendingSkin && <span className="skin-avatar-loading" />}
              </div>
              <div className="row" style={{ justifyContent: 'center', marginTop: 10 }}>
                <button
                  className="btn btn-sm"
                  onClick={() => refreshSkin(accountId)}
                  disabled={refreshingSkin || skinBusy}
                  title="忽略缓存,重新获取该账户最新皮肤"
                >
                  {refreshingSkin ? '刷新中…' : '刷新皮肤预览'}
                </button>
              </div>
            </div>

            {selectedAccount?.type === 'microsoft' && (
              <div className="field" style={{ marginBottom: 12 }}>
                <label className="field-label">皮肤模型</label>
                <div className="row" style={{ gap: 16 }}>
                  <label className="field-label" style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input type="radio" name="skinVariant" checked={skinVariant === 'classic'} onChange={() => setSkinVariant('classic')} />
                    经典(Steve)
                  </label>
                  <label className="field-label" style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input type="radio" name="skinVariant" checked={skinVariant === 'slim'} onChange={() => setSkinVariant('slim')} />
                    纤细(Alex)
                  </label>
                </div>
              </div>
            )}

            <div className="field" style={{ marginBottom: 12 }}>
              <label className="field-label">从本地文件选择(PNG,64x64 或 64x32)</label>
              <div className="row" style={{ gap: 10, alignItems: 'center' }}>
                <input
                  id="skin-file-input"
                  className="file-pick-input"
                  type="file"
                  accept="image/png,.png"
                  onChange={onSkinFile}
                />
                <label className="file-pick-btn" htmlFor="skin-file-input">
                  <span className="file-pick-icon">📁</span>
                  选择文件
                </label>
                <span className={`file-pick-name${pendingSkinName ? '' : ' empty'}`}>
                  {pendingSkinName || '未选择文件'}
                </span>
              </div>
              {pendingSkin && (
                <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={applyPendingSkin} disabled={skinBusy}>
                  {skinBusy ? '应用中…' : '应用此皮肤'}
                </button>
              )}
            </div>

            <div className="field" style={{ marginBottom: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <label className="field-label">或搜索正版账户名(使用其皮肤)</label>
              <div className="row" style={{ gap: 8 }}>
                <input
                  className="input"
                  value={searchName}
                  onChange={(e) => setSearchName(e.target.value)}
                  placeholder="正版用户名,例如 Notch"
                  style={{ flex: 1 }}
                  onKeyDown={(e) => e.key === 'Enter' && searchPremiumSkin()}
                />
                <button className="btn" onClick={searchPremiumSkin} disabled={searching}>
                  {searching ? '搜索中…' : '搜索并应用'}
                </button>
              </div>
            </div>

            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <button className="btn btn-danger" onClick={resetSkin} disabled={skinBusy}>
                重置为默认
              </button>
              <button
                className="btn"
                onClick={() => {
                  setSkinOpen(false);
                  setPendingSkin(null);
                  setPendingSkinName('');
                }}
                disabled={skinBusy}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
