import { useEffect, useRef, useState, type JSX } from 'react';
import type { AppSettings } from '@shared/types';
import { notify } from '../lib/toast';
import { getAppearance, setAppearance, type ColorMode } from '../lib/appearance';
import { THEMES, themeName } from '../lib/themes';

/**
 * Launcher-level appearance / personalisation settings.
 */
export default function Personalize(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [theme, setTheme] = useState('emerald');
  const [colorMode, setColorMode] = useState<ColorMode>('dark');
  const [opacity, setOpacity] = useState(0.35);
  const [hasBg, setHasBg] = useState(false);
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
