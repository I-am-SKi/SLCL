import { useEffect, useState, type JSX, type ReactNode } from 'react';
import { Toaster } from './components/Toaster';
import { ConfirmHost } from './components/ConfirmDialog';
import { CrashDialogHost, showCrashReport } from './components/CrashDialog';
import { Splash } from './components/Splash';
import Home from './pages/Home';
import Versions from './pages/Versions';
import Resources from './pages/Resources';
import Settings from './pages/Settings';
import Personalize from './pages/Personalize';
import More from './pages/More';
import Downloads from './pages/Downloads';
import { updateDownload, useActiveDownload } from './lib/download';
import { formatBytes } from './lib/toast';
import { initAppearance, subscribeAppearance, type Appearance } from './lib/appearance';
import { restoreSlatt } from './lib/slatt';

type View = 'home' | 'versions' | 'resources' | 'downloads' | 'settings' | 'personalize' | 'more';

function Icon({ d }: { d: string }): ReactNode {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

const NAV: Array<{ id: View; label: string; d: string }> = [
  { id: 'home', label: '主页', d: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10' },
  { id: 'versions', label: '版本管理', d: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM3.3 7l8.7 5 8.7-5M12 22V12' },
  { id: 'resources', label: '资源下载', d: 'M12 3v12m0 0l4-4m-4 4l-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2' },
  { id: 'settings', label: '游戏设置', d: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' },
  // Palette: three paint dots inside an artist's palette — reads as "appearance".
  { id: 'personalize', label: '启动器个性化', d: 'M12 21a9 9 0 1 1 0-18c4.97 0 9 3.58 9 8 0 2.21-1.79 4-4 4h-2a2 2 0 0 0 0 4 2 2 0 0 1-2 2zM8 12.5h.01M10.5 8.5h.01M15 8h.01' },
  // Three dots, moved here from the old personalisation entry.
  { id: 'more', label: '更多', d: 'M12 5a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM12 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2z' },
];

export default function App(): JSX.Element {
  const [view, setView] = useState<View>('home');
  const [maximized, setMaximized] = useState(false);
  const [appearance, setAppearance] = useState<Appearance>(() => ({
    colorMode: 'dark',
    theme: 'emerald',
    backgroundImage: '',
    backgroundOpacity: 0.35,
  }));

  // Single global progress subscription — lives here so it never unmounts on navigation.
  useEffect(() => {
    const unsub = window.slcl.versions.onProgress((p) => updateDownload(p));
    return unsub;
  }, []);

  // Crash reports are app-wide: the user may have navigated away by the time the
  // game dies, so the dialog host lives here rather than inside Home.
  useEffect(() => window.slcl.launch.onCrash(showCrashReport), []);

  // Validate the SLATT team token once per start so the home badge can appear
  // without the user opening the 更多 page first.
  useEffect(() => {
    void restoreSlatt();
  }, []);

  // Apply persisted theme + background once at startup, then subscribe to changes.
  useEffect(() => {
    initAppearance().then(setAppearance);
    const unsub = subscribeAppearance(setAppearance);
    return unsub;
  }, []);

  // Track the window's maximize state for the custom title bar.
  useEffect(() => {
    void window.slcl.window.isMaximized().then(setMaximized);
    return window.slcl.window.onMaximized(setMaximized);
  }, []);

  const hasBackground = appearance.backgroundImage !== '';

  return (
    <div className="app-root">
      {/* Custom title bar (the native one is disabled in the main process). */}
      <header className="titlebar">
        <div className="titlebar-brand">
          <span
            className="titlebar-logo"
            aria-hidden="true"
            style={{
              // Resolved against the document, so it works in dev and packaged builds.
              WebkitMaskImage: 'url(mark.png)',
              maskImage: 'url(mark.png)',
            }}
          />
          <span className="titlebar-title">SLCL</span>
        </div>

        <div className="titlebar-controls">
          <button
            className="titlebar-btn"
            title="最小化"
            aria-label="最小化"
            onClick={() => void window.slcl.window.minimize()}
          >
            <svg viewBox="0 0 10 10" aria-hidden="true">
              <path d="M2 5h6" stroke="currentColor" strokeWidth="1" fill="none" />
            </svg>
          </button>
          <button
            className="titlebar-btn"
            title={maximized ? '还原' : '最大化'}
            aria-label={maximized ? '还原' : '最大化'}
            onClick={() => void window.slcl.window.toggleMaximize().then(setMaximized)}
          >
            {maximized ? (
              <svg viewBox="0 0 10 10" aria-hidden="true">
                <rect x="2.5" y="2.5" width="5" height="5" stroke="currentColor" strokeWidth="1" fill="none" />
                <path d="M1.5 6.5v2h2" stroke="currentColor" strokeWidth="1" fill="none" />
              </svg>
            ) : (
              <svg viewBox="0 0 10 10" aria-hidden="true">
                <rect x="2" y="2" width="6" height="6" stroke="currentColor" strokeWidth="1" fill="none" />
              </svg>
            )}
          </button>
          <button
            className="titlebar-btn titlebar-close"
            title="关闭"
            aria-label="关闭"
            onClick={() => void window.slcl.window.close()}
          >
            <svg viewBox="0 0 10 10" aria-hidden="true">
              <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" stroke="currentColor" strokeWidth="1" fill="none" />
            </svg>
          </button>
        </div>
      </header>

      <div className={`app-shell${hasBackground ? ' has-bg' : ''}`}>
        <div
          className="app-background"
          style={{
            backgroundImage: hasBackground ? `url(${appearance.backgroundImage})` : 'none',
            opacity: appearance.backgroundOpacity,
          }}
        />
        <aside className="sidebar">
          <div className="brand">
            <img className="brand-logo" src="logo.png" alt="SLCL" />
            <div>
              <div className="brand-name">SLCL</div>
              <div className="brand-sub">SLATT CLIENT</div>
            </div>
          </div>
          {NAV.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id ? 'active' : ''}`}
              onClick={() => setView(item.id)}
            >
              <Icon d={item.d} />
              {item.label}
            </button>
          ))}
        </aside>
        <main className="content">
          <div key={view} className="page-transition">
            {view === 'home' && <Home onNavigate={setView} />}
            {view === 'versions' && <Versions />}
            {view === 'resources' && <Resources onNavigate={setView} />}
            {view === 'settings' && <Settings />}
            {view === 'personalize' && <Personalize />}
            {view === 'downloads' && <Downloads />}
            {view === 'more' && <More />}
          </div>
        </main>
      </div>

      <GlobalDownloadBar onOpen={() => setView('downloads')} />

      <Toaster />
      <ConfirmHost />
      <CrashDialogHost />
      <Splash />
    </div>
  );
}

/**
 * Floating progress bar.
 *
 * Kept out of `App` on purpose: it re-renders on every progress tick (~5/s), and
 * holding that state in `App` would re-render the whole page tree — noticeably
 * janky while scrolling the resource list during a download.
 */
function GlobalDownloadBar({ onOpen }: { onOpen: () => void }): JSX.Element | null {
  const download = useActiveDownload();
  if (!download) return null;

  const { progress, speed, kind, id } = download;
  const pct = Math.round(progress.progress * 100);

  return (
    <div className="global-download">
      <div className="row-between">
        <button className="global-download-title link-btn" onClick={onOpen} title="打开下载管理">
          {kind === 'install' ? `正在安装 ${id}` : `正在修复 ${id}`}
        </button>
        <div className="row" style={{ gap: 8 }}>
          <span className="muted small">
            {progress.totalBytes > 0
              ? `${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.totalBytes)}`
              : formatBytes(progress.downloadedBytes)}
            {speed > 0 && ` · ${formatBytes(speed)}/s`}
            {progress.totalFiles ? ` · ${progress.completedFiles ?? 0}/${progress.totalFiles} 个文件` : ''}
          </span>
          <button className="btn" onClick={onOpen}>
            详情
          </button>
          <button className="btn btn-danger" onClick={() => window.slcl.versions.cancel()}>
            取消下载
          </button>
        </div>
      </div>
      <div className="progress-track" style={{ marginTop: 8 }}>
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="muted small" style={{ margin: '6px 0 0' }}>
        {progress.task} · 可切换到其他页面,下载会在后台继续
      </p>
    </div>
  );
}
