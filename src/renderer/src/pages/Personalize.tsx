import { useEffect, useRef, useState, type JSX } from 'react';
import type { AppSettings } from '@shared/types';
import { notify } from '../lib/toast';
import { getAppearance, setAppearance, type ColorMode, type TitlebarMode } from '../lib/appearance';
import { THEMES, themeName } from '../lib/themes';

/** Upper bound on the custom title bar text, matched by the input's maxLength. */
const MAX_TITLEBAR_LENGTH = 32;

/**
 * Launcher-level appearance / personalisation settings.
 */
export default function Personalize(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [theme, setTheme] = useState('emerald');
  const [colorMode, setColorMode] = useState<ColorMode>('dark');
  const [opacity, setOpacity] = useState(0.35);
  const [hasBg, setHasBg] = useState(false);
  const [titlebarMode, setTitlebarMode] = useState<TitlebarMode>('default');
  const [titlebarText, setTitlebarText] = useState('');
  const [titlebarIcon, setTitlebarIcon] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      const s = await window.slcl.settings.get();
      setSettings(s);
      const a = getAppearance();
      setColorMode(a.colorMode);
      setTheme(a.theme || 'emerald');
      setOpacity(typeof a.backgroundOpacity === 'number' ? a.backgroundOpacity : 0.35);
      setHasBg(Boolean(a.backgroundImage));
      setTitlebarMode(a.titlebarMode);
      setTitlebarText(a.titlebarText);
      setTitlebarIcon(a.titlebarIcon);
    })();
  }, []);

  async function update(patch: Partial<AppSettings>): Promise<void> {
    const updated = await window.slcl.settings.update(patch);
    setSettings(updated);
  }

  async function pickMode(mode: ColorMode): Promise<void> {
    setColorMode(mode);
    setAppearance({ colorMode: mode });
    await update({ colorMode: mode });
  }

  async function pickTheme(id: string): Promise<void> {
    setTheme(id);
    setAppearance({ theme: id });
    await update({ theme: id });
  }

  /**
   * Toggle the logo. Applied to the appearance singleton immediately (the real
   * title bar animates right away) and persisted straight after — unlike the text
   * field there is no per-keystroke cost, so no need to wait for a blur.
   */
  async function toggleTitlebarIcon(): Promise<void> {
    const next = !titlebarIcon;
    setTitlebarIcon(next);
    setAppearance({ titlebarIcon: next });
    await update({ titlebarIcon: next });
  }

  async function pickTitlebarMode(mode: TitlebarMode): Promise<void> {
    setTitlebarMode(mode);
    setAppearance({ titlebarMode: mode });
    await update({ titlebarMode: mode });
  }

  /**
   * Reflect the typed title immediately, without touching the settings store.
   *
   * The real title bar sits at the top of the window while the user types, so it
   * has to follow along — otherwise the "preview" they are editing is several
   * hundred pixels away from the thing being edited.
   */
  function previewTitlebarText(value: string): void {
    setTitlebarText(value);
    setAppearance({ titlebarText: value });
  }

  /**
   * Persist the title. Deliberately only on blur / Enter: each save round-trips
   * through IPC and rewrites config.json, which is wasteful per keystroke.
   *
   * The "already saved" comparison has to use the *persisted* settings, not the
   * appearance singleton — the latter already holds the typed value (that is what
   * drives the live preview), so comparing against it would skip every save.
   */
  async function commitTitlebarText(value: string): Promise<void> {
    const next = value.slice(0, MAX_TITLEBAR_LENGTH);
    if (next === (settings?.titlebarText ?? '')) return;
    setTitlebarText(next);
    setAppearance({ titlebarText: next });
    await update({ titlebarText: next });
  }

  async function setBgOpacity(value: number): Promise<void> {
    setOpacity(value);
    setAppearance({ backgroundOpacity: value });
    await update({ backgroundOpacity: value });
  }

  /** Read a picked image, downscale it, and store it as the background. */
  function onPickFile(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      notify('请选择图片文件', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const src = reader.result as string;
      const dataUrl = await downscaleImage(src, 2560, 0.85);
      setHasBg(true);
      setAppearance({ backgroundImage: dataUrl });
      await update({ backgroundImage: dataUrl });
      notify('已更换启动器背景', 'success');
    };
    reader.readAsDataURL(file);
  }

  async function removeBackground(): Promise<void> {
    setHasBg(false);
    setAppearance({ backgroundImage: '' });
    await update({ backgroundImage: '' });
    notify('已移除背景图片', 'info');
  }

  return (
    <div>
      <h1 className="page-title">启动器个性化</h1>
      <p className="page-subtitle">定制启动器的外观与背景。</p>

      {/* ---- color mode ---- */}
      <div className="card">
        <div className="card-title">明暗模式</div>
        <p className="muted small" style={{ margin: '0 0 14px' }}>
          深色模式是默认外观;浅色模式会同步调整底色、文字与边框,与主题色搭配使用。
        </p>
        <div className="mode-grid">
          <button
            className={`mode-card${colorMode === 'dark' ? ' active' : ''}`}
            onClick={() => void pickMode('dark')}
          >
            <span className="mode-preview mode-preview-dark">
              <span className="mode-bar" />
              <span className="mode-block" />
            </span>
            <span className="mode-name">
              深色
              {colorMode === 'dark' && <span className="badge badge-accent">当前</span>}
            </span>
          </button>
          <button
            className={`mode-card${colorMode === 'light' ? ' active' : ''}`}
            onClick={() => void pickMode('light')}
          >
            <span className="mode-preview mode-preview-light">
              <span className="mode-bar" />
              <span className="mode-block" />
            </span>
            <span className="mode-name">
              浅色
              {colorMode === 'light' && <span className="badge badge-accent">当前</span>}
            </span>
          </button>
        </div>
      </div>

      {/* ---- theme ---- */}
      <div className="card">
        <div className="card-title">颜色主题</div>
        <p className="muted small" style={{ margin: '0 0 14px' }}>
          当前主题:<span className="accent-text">{themeName(theme)}</span>
          {' · '}
          {colorMode === 'light' ? '浅色模式' : '深色模式'}
        </p>
        <div className="theme-grid">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={`theme-card${theme === t.id ? ' active' : ''}`}
              onClick={() => void pickTheme(t.id)}
            >
              <span
                className="theme-swatch"
                style={{ background: colorMode === 'light' ? t.colorLight : t.color }}
              />
              <span className="theme-name">{t.name}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ---- title bar ---- */}
      <div className="card">
        <div className="card-title">标题栏</div>
        <p className="muted small" style={{ margin: '0 0 14px' }}>
          标题栏的文字与图标可以分别控制。文字颜色跟随明暗模式与主题,无需单独设置。
        </p>

        {/* Icon toggle: independent of the text mode, so it applies to both. */}
        <div className="switch-row" style={{ marginBottom: 16 }}>
          <button
            type="button"
            role="switch"
            aria-checked={titlebarIcon}
            aria-label="显示启动器图标"
            className={`switch${titlebarIcon ? ' on' : ''}`}
            onClick={() => void toggleTitlebarIcon()}
          />
          <div className="switch-row-text">
            <div className="switch-row-title">显示启动器图标</div>
            <div className="muted small">
              关闭后标题栏只保留文字,默认与自定义模式下都生效。
              若文字也留空,整条标题栏就只剩右上角的窗口按钮。
            </div>
          </div>
        </div>

        <div className="mode-grid">
          {(['default', 'custom'] as const).map((mode) => {
            const label = mode === 'default' ? '默认' : '自定义';
            // Mirrors what the real title bar will render for that mode, so the two
            // previews also demonstrate the icon toggle.
            const previewText = mode === 'default' ? 'SLCL' : titlebarText.trim();
            return (
              <button
                key={mode}
                className={`mode-card${titlebarMode === mode ? ' active' : ''}`}
                onClick={() => void pickTitlebarMode(mode)}
              >
                <span className="tb-preview">
                  <span
                    className={`tb-preview-slot${titlebarIcon ? '' : ' is-hidden'}`}
                    aria-hidden="true"
                  >
                    <span
                      className="tb-preview-mark"
                      style={{ WebkitMaskImage: 'url(mark.png)', maskImage: 'url(mark.png)' }}
                    />
                  </span>
                  {previewText !== '' && <span className="tb-preview-text">{previewText}</span>}
                  <span className="tb-preview-btns" aria-hidden="true">
                    <i /><i /><i />
                  </span>
                </span>
                <span className="mode-name">
                  {label}
                  {titlebarMode === mode && <span className="badge badge-accent">当前</span>}
                </span>
              </button>
            );
          })}
        </div>

        {titlebarMode === 'custom' && (
          <div className="field" style={{ marginTop: 16, maxWidth: 520 }}>
            <div className="row-between">
              <label className="field-label" style={{ margin: 0 }} htmlFor="titlebar-text">
                标题文字
              </label>
              <span className="muted small">
                {titlebarText.length} / {MAX_TITLEBAR_LENGTH}
              </span>
            </div>
            <input
              id="titlebar-text"
              className="input"
              value={titlebarText}
              maxLength={MAX_TITLEBAR_LENGTH}
              placeholder="留空则不显示标题文字"
              onChange={(e) => previewTitlebarText(e.target.value)}
              onBlur={(e) => void commitTitlebarText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void commitTitlebarText(titlebarText)}
              style={{ marginTop: 8 }}
            />
            <p className="muted small" style={{ margin: '6px 0 0' }}>
              按回车或点其它地方即保存。留空则不显示文字;图标由上方开关单独控制。
            </p>
          </div>
        )}
      </div>

      {/* ---- background ---- */}
      <div className="card">
        <div className="card-title">背景图片</div>
        <p className="muted small" style={{ margin: '0 0 14px' }}>
          上传一张图片作为启动器背景,可自由调节不透明度。
        </p>

        <div className="bg-preview" style={{ backgroundImage: hasBg ? `url(${getAppearance().backgroundImage})` : 'none' }}>
          {!hasBg && <span className="muted small">尚未设置背景</span>}
        </div>

        <div className="row" style={{ marginTop: 14, flexWrap: 'wrap' }}>
          <input ref={fileRef} type="file" accept="image/*" className="file-pick-input" onChange={onPickFile} />
          <button className="btn btn-primary" onClick={() => fileRef.current?.click()}>
            上传图片
          </button>
          {hasBg && (
            <button className="btn btn-danger" onClick={() => void removeBackground()}>
              移除背景
            </button>
          )}
        </div>

        <div className="field" style={{ marginTop: 16 }}>
          <div className="row-between">
            <label className="field-label" style={{ margin: 0 }}>
              不透明度
            </label>
            <span className="muted small">{Math.round(opacity * 100)}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={opacity}
            onChange={(e) => void setBgOpacity(Number(e.target.value))}
            className="range"
            style={{ marginTop: 8 }}
          />
        </div>
      </div>

      <p className="muted small" style={{ marginTop: 16 }}>
        SLCL {settings ? '' : ''} · 启动器外观设置即时生效并自动保存。
      </p>
    </div>
  );
}

/** Downscale + re-encode an image to keep the stored background small. */
function downscaleImage(src: string, maxWidth: number, quality: number): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.naturalWidth);
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(src);
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      // Keep PNG for images with transparency; otherwise compress to JPEG.
      const isPng = src.startsWith('data:image/png');
      resolve(canvas.toDataURL(isPng ? 'image/png' : 'image/jpeg', quality));
    };
    img.onerror = () => resolve(src);
    img.src = src;
  });
}
