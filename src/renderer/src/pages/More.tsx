import { useCallback, useEffect, useState, type JSX } from 'react';
import type { AccountProfile, SlattSession, SlattSkin } from '@shared/types';
import { notify } from '../lib/toast';
import { ipcErrorMessage } from '../lib/ipcError';
import { getSlattSession, isSlattReady, setSlattSession, subscribeSlatt } from '../lib/slatt';
import SkinHead from '../components/SkinHead';
import { loadSkinPngUrl } from '../lib/skinImage';

/**
 * 「更多」页 —— SLATT 团队站点（slatt.cn）集成。
 *
 * 这个功能只面向 SLATT 团队成员：官网账号本身只允许团队成员注册，因此登录成功
 * 即视为团队成员。页面包含四块：团队账号、团队皮肤库、快捷入口、版权声明。
 *
 * 皮肤库在 UI 层做了登录门禁 —— 未登录时不渲染、也不请求 /api/skins。注意这
 * 只是界面上的约束：该接口在站点侧是公开的，真正的访问控制需要后端加鉴权。
 */

const SITE_URL = 'https://slatt.cn';
const AUTHOR_URL = 'https://space.bilibili.com/299653635';
const TEAM_URL = 'https://space.bilibili.com/3546847685642367';

const ACCOUNT_TYPE_LABEL: Record<AccountProfile['type'], string> = {
  offline: '离线登录',
  microsoft: 'Microsoft 正版',
  littleskin: 'LittleSkin',
};

const MODEL_LABEL: Record<SlattSkin['model'], string> = {
  classic: '经典',
  slim: '纤细',
};

export default function More(): JSX.Element {
  const [session, setSession] = useState<SlattSession | null>(() => getSlattSession());
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const [skins, setSkins] = useState<SlattSkin[]>([]);
  const [skinsLoading, setSkinsLoading] = useState(false);
  const [skinsError, setSkinsError] = useState('');

  /** The skin pending installation; non-null opens the account picker. */
  const [pendingSkin, setPendingSkin] = useState<SlattSkin | null>(null);
  /**
   * True while the startup token check is still in flight. Without this the page
   * would briefly show the sign-in form and then flip to the member card.
   */
  const [checking, setChecking] = useState(() => !isSlattReady());
  /** Set when the remote avatar fails to load, so we fall back to the initial. */
  const [avatarBroken, setAvatarBroken] = useState(false);
  /** Skin library collapse state — open by default so members see it immediately. */
  const [libraryOpen, setLibraryOpen] = useState(true);

  // A different member means a different (or newly working) avatar URL.
  useEffect(() => setAvatarBroken(false), [session?.user.uid]);

  useEffect(
    () =>
      subscribeSlatt((s) => {
        setSession(s);
        setChecking(false);
      }),
    [],
  );

  const loadSkins = useCallback(async (force = false): Promise<void> => {
    setSkinsLoading(true);
    setSkinsError('');
    try {
      const list = await window.slcl.slatt.skins(force);
      setSkins(list);
    } catch (e) {
      setSkins([]);
      setSkinsError(ipcErrorMessage(e));
    } finally {
      setSkinsLoading(false);
    }
  }, []);

  // The library is gated behind the login: no session, no request.
  useEffect(() => {
    if (!session) {
      setSkins([]);
      setSkinsError('');
      return;
    }
    void loadSkins();
  }, [session, loadSkins]);

  async function signIn(): Promise<void> {
    if (signingIn) return;
    setSigningIn(true);
    try {
      const next = await window.slcl.slatt.login(account, password);
      setSlattSession(next);
      setSession(next);
      setAccount('');
      setPassword('');
      notify(`已登录 SLATT 团队账号：${next.user.username}`, 'success');
    } catch (e) {
      notify(ipcErrorMessage(e), 'error');
    } finally {
      setSigningIn(false);
    }
  }

  async function signOut(): Promise<void> {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await window.slcl.slatt.logout();
      setSlattSession(null);
      setSession(null);
      notify('已退出 SLATT 团队账号', 'info');
    } catch (e) {
      notify(ipcErrorMessage(e), 'error');
    } finally {
      setSigningOut(false);
    }
  }

  const user = session?.user;

  return (
    <div className="more-page">
      <h1 className="page-title">更多</h1>
      <p className="page-subtitle">SLATT 团队账号、团队皮肤库与相关链接。</p>

      {/* ---- SLATT team account ---- */}
      <div className="card slatt-account-card">
        {checking ? (
          <div className="slatt-checking">
            <span className="slatt-checking-dot" aria-hidden="true" />
            正在验证登录状态…
          </div>
        ) : user ? (
          <div className="slatt-member">
            {user.avatarUrl && !avatarBroken ? (
              <img
                className="slatt-avatar"
                src={user.avatarUrl}
                alt=""
                referrerPolicy="no-referrer"
                onError={() => setAvatarBroken(true)}
              />
            ) : (
              <div className="slatt-avatar slatt-avatar-fallback" aria-hidden="true">
                {user.username.charAt(0).toUpperCase() || 'S'}
              </div>
            )}
            <div className="slatt-member-meta">
              <div className="slatt-member-name">{user.username}</div>
              <div className="slatt-member-tags">
                <span className="badge badge-accent">{user.roleLabel}</span>
                {user.hasSkin && <span className="badge">官网已绑定皮肤</span>}
              </div>
            </div>
            <span className="spacer" />
            <button className="btn" onClick={() => void signOut()} disabled={signingOut}>
              {signingOut ? '正在退出…' : '退出登录'}
            </button>
          </div>
        ) : (
          <div className="slatt-signin">
            <div className="slatt-signin-head">
              <div className="slatt-signin-mark" aria-hidden="true">
                S
              </div>
              <div>
                <div className="card-title" style={{ margin: 0 }}>
                  SLATT 团队账号
                </div>
                <p className="muted small" style={{ margin: '4px 0 0' }}>
                  使用 slatt.cn 官网账号登录。该账号仅对 SLATT 团队成员开放注册。
                </p>
              </div>
            </div>

            <div className="slatt-signin-form">
              <div className="field">
                <label className="field-label">账号或邮箱</label>
                <input
                  className="input"
                  value={account}
                  onChange={(e) => setAccount(e.target.value)}
                  placeholder="官网用户名或邮箱"
                  autoComplete="username"
                  onKeyDown={(e) => e.key === 'Enter' && void signIn()}
                />
              </div>
              <div className="field">
                <label className="field-label">密码</label>
                <input
                  className="input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="官网登录密码"
                  autoComplete="current-password"
                  onKeyDown={(e) => e.key === 'Enter' && void signIn()}
                />
              </div>
              <button
                className="btn btn-primary slatt-signin-submit"
                onClick={() => void signIn()}
                disabled={signingIn}
              >
                {signingIn ? '登录中…' : '登录'}
              </button>
            </div>

            <p className="muted small slatt-signin-foot">
              登录凭证仅用于获取团队皮肤库，会以系统级加密保存在本机，不会写入日志。
            </p>
          </div>
        )}
      </div>

      {/* ---- team skin library (members only, collapsible, open by default) ---- */}
      {user && !checking && (
        <div className="card slatt-library">
          <button
            className="slatt-library-head"
            onClick={() => setLibraryOpen((v) => !v)}
            aria-expanded={libraryOpen}
          >
            <span className="slatt-library-title">
              <span className={`chevron${libraryOpen ? ' open' : ''}`} aria-hidden="true">
                ▸
              </span>
              团队皮肤库
              {!skinsLoading && <span className="badge">{skins.length} 款</span>}
            </span>
            <span className="muted small">{libraryOpen ? '收起' : '展开'}</span>
          </button>

          {libraryOpen && (
            <div className="slatt-library-body">
              <div className="row-between" style={{ marginBottom: 10 }}>
                <p className="muted small" style={{ margin: 0 }}>
                  {skinsLoading
                    ? '正在读取团队皮肤库…'
                    : `共 ${skins.length} 款皮肤，来自团队成员上传`}
                </p>
                <button
                  className="btn btn-sm"
                  onClick={() => void loadSkins(true)}
                  disabled={skinsLoading}
                >
                  刷新
                </button>
              </div>

              {skinsError && <div className="slatt-error">{skinsError}</div>}

              {!skinsError && skinsLoading && skins.length === 0 && (
                <div className="slatt-skin-grid">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <div className="slatt-skin-card loading" key={i}>
                      <span className="slatt-skin-thumb" />
                      <span className="slatt-skin-line" />
                      <span className="slatt-skin-line short" />
                    </div>
                  ))}
                </div>
              )}

              {!skinsError && !skinsLoading && skins.length === 0 && (
                <div className="slatt-empty">团队皮肤库暂时没有可用的皮肤。</div>
              )}

              {skins.length > 0 && (
                <div className="slatt-skin-grid">
                  {skins.map((skin, i) => (
                    <div
                      className="slatt-skin-card"
                      key={skin.id}
                      style={{ animationDelay: `${Math.min(i, 12) * 40}ms` }}
                    >
                      <span className="slatt-skin-thumb">
                        <SkinHead skin={skin.skinUrl} size={64} />
                      </span>
                      <div className="slatt-skin-name" title={skin.name}>
                        {skin.name}
                      </div>
                      <div className="slatt-skin-meta">
                        {skin.uploaderName && (
                          <span className="slatt-skin-by" title={skin.uploaderName}>
                            by {skin.uploaderName}
                          </span>
                        )}
                        <span className={`badge${skin.model === 'slim' ? ' badge-blue' : ''}`}>
                          {MODEL_LABEL[skin.model]}
                        </span>
                      </div>
                      <button className="btn btn-sm btn-block" onClick={() => setPendingSkin(skin)}>
                        安装
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ---- shortcuts ---- */}
      <div className="card">
        <div className="card-title">相关链接</div>
        <div className="slatt-links">
          <button className="slatt-link" onClick={() => void window.slcl.openExternal(SITE_URL)}>
            <span className="slatt-link-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
              </svg>
            </span>
            <span className="slatt-link-text">
              <span className="slatt-link-title">SLATT 团队官网</span>
              <span className="slatt-link-desc">slatt.cn · 团队主页与账号中心</span>
            </span>
            <span className="slatt-link-arrow" aria-hidden="true">
              ›
            </span>
          </button>

          <button className="slatt-link" onClick={() => void window.slcl.openExternal(AUTHOR_URL)}>
            <span className="slatt-link-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" />
              </svg>
            </span>
            <span className="slatt-link-text">
              <span className="slatt-link-title">作者</span>
              <span className="slatt-link-desc">SLATT团队-SKi斯基 · B 站主页</span>
            </span>
            <span className="slatt-link-arrow" aria-hidden="true">
              ›
            </span>
          </button>

          <button className="slatt-link" onClick={() => void window.slcl.openExternal(TEAM_URL)}>
            <span className="slatt-link-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 20v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M10 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM21 20v-2a4 4 0 0 0-3-3.87M16.5 3.3a3.5 3.5 0 0 1 0 6.8" />
              </svg>
            </span>
            <span className="slatt-link-text">
              <span className="slatt-link-title">鸣谢 SLATT团队</span>
              <span className="slatt-link-desc">团队 B 站主页</span>
            </span>
            <span className="slatt-link-arrow" aria-hidden="true">
              ›
            </span>
          </button>
        </div>
      </div>

      {/* ---- copyright ---- */}
      <div className="slatt-copyright">
        <div className="slatt-copyright-title">版权声明</div>
        <p>
          SLCL（SLATT Client）© 2026 SLATT团队-SKi斯基，以 MIT 许可证开源发布。
        </p>
        <p>
          本项目不包含任何 Minecraft 游戏文件，游戏资源在首次启动时由使用者本机下载。
          Minecraft 是 Mojang Studios / Microsoft 的商标，本项目与 Mojang、Microsoft
          无关联，未获其认可或授权。
        </p>
        <p>
          团队皮肤库内容由 SLATT 团队成员上传，版权归各自作者所有。
        </p>
      </div>

      {pendingSkin && (
        <SkinTargetDialog
          skin={pendingSkin}
          onClose={() => setPendingSkin(null)}
          onDone={() => setPendingSkin(null)}
        />
      )}
    </div>
  );
}

/**
 * 选择皮肤的去向：应用到某个 Minecraft 账户，或直接保存到任意文件夹。
 *
 * 两种模式共用一个弹窗，因为它们是同一个动作的两种落点；把「下载到文件夹」
 * 做成独立入口会让用户以为它是另一项功能。
 * 默认选中启动器当前账户 —— 绝大多数情况下用户只想改自己正在用的那个。
 */
function SkinTargetDialog({
  skin,
  onClose,
  onDone,
}: {
  skin: SlattSkin;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const [mode, setMode] = useState<'account' | 'folder'>('account');
  const [accounts, setAccounts] = useState<AccountProfile[] | null>(null);
  const [targetId, setTargetId] = useState('');
  const [folder, setFolder] = useState('');
  const [applying, setApplying] = useState(false);
  /** Natural pixel size of this skin, used to warn about unsupported HD sizes. */
  const [skinSize, setSkinSize] = useState<{ width: number; height: number } | null>(null);

  // Read the real PNG dimensions so the dialog can warn *before* the user commits:
  // Mojang only accepts 64x64 / 64x32, and the library contains 128x128 skins.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const url = await loadSkinPngUrl(skin.skinUrl);
        const img = new Image();
        img.onload = (): void => {
          if (!cancelled) setSkinSize({ width: img.naturalWidth, height: img.naturalHeight });
        };
        img.src = url;
      } catch {
        /* size stays null; the backend still validates on upload */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [skin.skinUrl]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [all, settings] = await Promise.all([
          window.slcl.accounts.list(),
          window.slcl.settings.get(),
        ]);
        if (cancelled) return;
        // LittleSkin characters don't take a skin from here — their skin is owned
        // by LittleSkin and changed in its own closet — so they are left out
        // entirely rather than shown and then rejected.
        const list = all.filter((a) => a.type !== 'littleskin');
        setAccounts(list);
        const preferred = settings.selectedAccountId;
        setTargetId(
          preferred && list.some((a) => a.id === preferred) ? preferred : (list[0]?.id ?? ''),
        );
      } catch {
        if (!cancelled) setAccounts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !applying) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [applying, onClose]);

  async function pickFolder(): Promise<void> {
    const dir = await window.slcl.selectDirectory();
    if (dir) setFolder(dir);
  }

  async function apply(): Promise<void> {
    if (applying) return;

    if (mode === 'account') {
      if (!targetId) return;
      setApplying(true);
      try {
        const result = await window.slcl.slatt.applySkin(targetId, skin.id);
        if (result.uploaded) {
          // Microsoft account: the skin is now live on the Mojang profile.
          notify(
            `已将「${result.skinName}」上传到 ${result.accountName} 的正版账号，重新进入游戏后生效`,
            'success',
          );
        } else if (result.uploadError) {
          // Microsoft account, but the upload failed and we fell back to a preview.
          notify(
            `已更换 ${result.accountName} 的启动器预览，但上传到正版账号失败：${result.uploadError}`,
            'error',
          );
        } else {
          notify(`已将「${result.skinName}」应用到 ${result.accountName}`, 'success');
        }
        onDone();
      } catch (e) {
        notify(ipcErrorMessage(e), 'error');
      } finally {
        setApplying(false);
      }
      return;
    }

    if (!folder) return;
    setApplying(true);
    try {
      const saved = await window.slcl.slatt.saveSkin(skin.id, folder);
      notify(`已保存到 ${saved}`, 'success');
      onDone();
    } catch (e) {
      notify(ipcErrorMessage(e), 'error');
    } finally {
      setApplying(false);
    }
  }

  const canSubmit = mode === 'account' ? Boolean(targetId) : Boolean(folder);

  /**
   * Mojang rejects anything but 64x64 / 64x32. Warn as soon as a Microsoft account
   * is selected, so the user isn't surprised after clicking 安装.
   */
  const selectedAccount = accounts?.find((a) => a.id === targetId);
  const hdSkin = skinSize !== null && !(skinSize.width === 64 && (skinSize.height === 64 || skinSize.height === 32));
  const hdBlocksUpload = mode === 'account' && selectedAccount?.type === 'microsoft' && hdSkin;

  return (
    <div className="modal-backdrop" role="presentation" onClick={() => !applying && onClose()}>
      <div
        className="modal slatt-target-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="slatt-target-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="slatt-target-head">
          <span className="slatt-target-preview">
            <SkinHead skin={skin.skinUrl} size={48} />
          </span>
          <div>
            <div className="modal-title" id="slatt-target-title">
              安装皮肤
            </div>
            <p className="muted small" style={{ margin: '4px 0 0' }}>
              {skin.name}
              {skin.uploaderName ? ` · by ${skin.uploaderName}` : ''}
            </p>
          </div>
        </div>

        <div className="slatt-mode-switch" role="tablist" aria-label="去向">
          <button
            role="tab"
            aria-selected={mode === 'account'}
            className={`slatt-mode${mode === 'account' ? ' active' : ''}`}
            onClick={() => setMode('account')}
            disabled={applying}
          >
            应用到账户
          </button>
          <button
            role="tab"
            aria-selected={mode === 'folder'}
            className={`slatt-mode${mode === 'folder' ? ' active' : ''}`}
            onClick={() => setMode('folder')}
            disabled={applying}
          >
            保存到文件夹
          </button>
        </div>

        {mode === 'account' ? (
          <>
            <div className="field-label">选择要应用到的账户</div>

            {accounts === null && <div className="slatt-empty">正在读取账户…</div>}

            {accounts !== null && accounts.length === 0 && (
              <div className="slatt-empty">没有可安装的账户。LittleSkin 账户的皮肤由官网管理，请先在主页添加离线或正版账户。</div>
            )}

            {accounts !== null && accounts.length > 0 && (
              <div className="slatt-target-list">
                {accounts.map((a) => (
                  <label
                    key={a.id}
                    className={`slatt-target-row${targetId === a.id ? ' selected' : ''}`}
                  >
                    <input
                      type="radio"
                      name="slatt-target"
                      value={a.id}
                      checked={targetId === a.id}
                      onChange={() => setTargetId(a.id)}
                    />
                    <span className="slatt-target-name">{a.name}</span>
                    <span className="badge">{ACCOUNT_TYPE_LABEL[a.type]}</span>
                  </label>
                ))}
              </div>
            )}

            <p className="muted small" style={{ margin: '10px 0 0' }}>
              正版账户会上传到 Minecraft 官方账号，重新进入游戏后生效；离线账户直接作为游戏皮肤。
              上传正版皮肤需要有效的登录状态，令牌过期时请先重新登录。
            </p>

            {hdBlocksUpload && skinSize && (
              <div className="slatt-warn">
                <strong>这款皮肤无法上传到正版账号。</strong>
                Minecraft 官方只接受 64×64 或 64×32 的皮肤，而这款是 {skinSize.width}×{skinSize.height}。
                继续安装只会更换启动器内的预览；想真正改掉正版皮肤，请换用标准尺寸的皮肤。
              </div>
            )}
          </>
        ) : (
          <>
            <div className="field-label">保存位置</div>
            <div className="row" style={{ marginTop: 6 }}>
              <input
                className="input"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                placeholder="选择任意文件夹，皮肤会保存为 PNG"
                style={{ flex: 1, minWidth: 0 }}
                onKeyDown={(e) => e.key === 'Enter' && void apply()}
              />
              <button className="btn" onClick={() => void pickFolder()} disabled={applying}>
                浏览…
              </button>
            </div>
            <p className="muted small" style={{ margin: '10px 0 0' }}>
              文件名为皮肤名称，若重名会自动追加序号，不会覆盖已有文件。
            </p>
          </>
        )}

        <div className="dialog-actions" style={{ marginTop: 14 }}>
          <button className="btn" onClick={onClose} disabled={applying}>
            取消
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void apply()}
            disabled={applying || !canSubmit}
          >
            {applying
              ? mode === 'account'
                ? '安装中…'
                : '保存中…'
              : mode === 'account'
                ? '安装'
                : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
