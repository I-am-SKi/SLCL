import { useEffect, useState, type JSX } from 'react';
import type { AppSettings, DownloadProgress, JavaInstallation } from '@shared/types';
import { JAVA_MAJOR_MAX, JAVA_MAJOR_MIN, JAVA_RUNTIME_MAJORS } from '@shared/types';
import { formatBytes, notify } from '../lib/toast';

export default function Settings(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [javaList, setJavaList] = useState<JavaInstallation[]>([]);
  const [installingMajor, setInstallingMajor] = useState<number | null>(null);
  const [javaProgress, setJavaProgress] = useState<DownloadProgress | null>(null);
  const [javaListOpen, setJavaListOpen] = useState(false);
  const [customMajor, setCustomMajor] = useState('');

  useEffect(() => {
    window.slcl.settings.get().then(setSettings);
    detectJava();
    const unsub = window.slcl.java.onProgress((p) => setJavaProgress(p));
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function update(patch: Partial<AppSettings>): Promise<void> {
    const updated = await window.slcl.settings.update(patch);
    setSettings(updated);
  }

  async function chooseDirectory(): Promise<void> {
    const dir = await window.slcl.selectDirectory();
    if (dir) await update({ resourcePath: dir });
  }

  async function detectJava(): Promise<void> {
    setDetecting(true);
    try {
      setJavaList(await window.slcl.java.detect());
    } finally {
      setDetecting(false);
    }
  }

  async function installJava(major: number): Promise<void> {
    setInstallingMajor(major);
    setJavaProgress({ progress: 0, totalBytes: 0, downloadedBytes: 0, task: '准备中…' });
    try {
      const installed = await window.slcl.java.install(major);
      await detectJava();
      // Auto-select the newly installed Java in manual mode.
      await update({ javaPath: installed.path });
      notify(`已安装 Java ${installed.major} (${installed.version})`, 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === '已取消') notify('已取消下载 Java', 'info');
      else notify(msg, 'error');
    } finally {
      setInstallingMajor(null);
      setJavaProgress(null);
    }
  }

  async function cancelJava(): Promise<void> {
    await window.slcl.java.cancel();
  }

  async function importJavaFile(): Promise<void> {
    try {
      const imported = await window.slcl.java.importFile();
      if (!imported) return;
      await detectJava();
      await update({ javaPath: imported.path });
      notify(`已导入 Java ${imported.major} (${imported.version})`, 'success');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  /** Install an arbitrary Java major (not limited to the preset buttons). */
  async function installCustomJava(): Promise<void> {
    const major = Number(customMajor);
    if (!Number.isInteger(major) || major < JAVA_MAJOR_MIN || major > JAVA_MAJOR_MAX) {
      notify(`请输入 ${JAVA_MAJOR_MIN}–${JAVA_MAJOR_MAX} 之间的主版本号`, 'error');
      return;
    }
    await installJava(major);
    setCustomMajor('');
  }

  if (!settings) {
    return (
      <div>
        <h1 className="page-title">游戏设置</h1>
        <p className="muted">加载中…</p>
      </div>
    );
  }

  const installedMajors = new Set(javaList.map((j) => j.major));
  const selectedJava = javaList.find((j) => j.path === settings.javaPath);
  const selectedJavaLabel = selectedJava
    ? `Java ${selectedJava.major} (${selectedJava.version})`
    : settings.javaPath
      ? '自定义路径'
      : '未选择';

  return (
    <div>
      <h1 className="page-title">游戏设置</h1>
      <p className="page-subtitle">配置共享资源目录、Java 与启动参数。</p>

      <div className="card">
        <div className="card-title">当前游戏文件夹</div>
        <p className="muted small" style={{ margin: '0 0 12px' }}>
          版本、库(libraries)、资源(assets)文件存放于此,所有版本共享。这里的文件夹就是「版本管理」中的“当前文件夹”,
          新安装的游戏版本会写入这里;其余已添加的文件夹仍会被自动扫描。
        </p>
        <div className="row">
          <input className="input" value={settings.resourcePath} onChange={(e) => update({ resourcePath: e.target.value })} style={{ flex: 1 }} />
          <button className="btn" onClick={chooseDirectory}>
            选择目录
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-title">CurseForge API Key（可选）</div>
        <p className="muted small" style={{ margin: '0 0 12px' }}>
          留空即可正常浏览与安装 CurseForge 资源（经由国内镜像，无需密钥）。填写后改为优先直连
          CurseForge 官方接口，官方不可用时自动回退到镜像。密钥可在
          <button className="link-btn" onClick={() => window.slcl.openExternal('https://console.curseforge.com/')}>
            console.curseforge.com
          </button>
          免费申请。请注意：通过镜像下载不计入作者收益，若希望支持作者可填写密钥。
        </p>
        <div className="row">
          <input
            className="input"
            value={settings.curseforgeApiKey ?? ''}
            onChange={(e) => update({ curseforgeApiKey: e.target.value })}
            placeholder="粘贴 CurseForge API Key"
            style={{ flex: 1, fontFamily: "'Cascadia Code', Consolas, monospace", fontSize: 12 }}
          />
        </div>
      </div>

      <div className="card">
        <div className="card-title">Java 运行时</div>

        <div className="row" style={{ marginBottom: 14 }}>
          <label className="field-label" style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="radio" name="javaMode" checked={settings.javaSelection === 'auto'} onChange={() => update({ javaSelection: 'auto' })} />
            自动选择(推荐)
          </label>
          <label className="field-label" style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="radio" name="javaMode" checked={settings.javaSelection === 'manual'} onChange={() => update({ javaSelection: 'manual' })} />
            手动选择
          </label>
        </div>

        {settings.javaSelection === 'auto' && (
          <p className="muted small" style={{ margin: '0 0 12px' }}>
            启动时按版本自身声明的 Java 要求自动匹配(1.12.2 用 Java 8、1.18+ 用 Java 17、1.20.5+ 用 Java 21、26.x 用 Java 25)。
          </p>
        )}

        {/* Expandable list of every detected runtime (version + full path). */}
        <div className="accordion-section" style={{ marginBottom: 10 }}>
          <button className="accordion-header" onClick={() => setJavaListOpen((v) => !v)}>
            <span>Java 列表 ({javaList.length}{detecting ? ',扫描中…' : ''})</span>
            <span className="row" style={{ gap: 8 }}>
              {selectedJava && (
                <span className="muted small">
                  当前:{selectedJavaLabel}
                </span>
              )}
              <span className={`chevron ${javaListOpen ? 'open' : ''}`}>▸</span>
            </span>
          </button>
          {javaListOpen && (
            <div className="accordion-body">
              {detecting ? (
                <p className="muted small" style={{ margin: 0 }}>
                  正在扫描所有 Java…
                </p>
              ) : javaList.length === 0 ? (
                <p className="muted small" style={{ margin: 0 }}>
                  未检测到任何 Java。可在下方一键安装,或手动导入。
                </p>
              ) : (
                <div className="java-list">
                  {javaList.map((j) => {
                    const active = settings.javaSelection === 'manual' && settings.javaPath === j.path;
                    return (
                      <button
                        key={j.path}
                        className={`java-row${active ? ' selected' : ''}`}
                        onClick={() => {
                          void update({ javaPath: j.path, javaSelection: 'manual' });
                        }}
                        title={j.path}
                      >
                        <div className="java-row-main">
                          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                            <span className="badge badge-accent">Java {j.major}</span>
                            <span className="java-version">{j.version}</span>
                            <span className="badge">{j.is64Bit ? '64 位' : '32 位'}</span>
                            {j.isManaged && <span className="badge badge-blue">SLCL 安装</span>}
                            {active && <span className="badge badge-accent">当前使用</span>}
                          </div>
                          <span className="path-code java-path">{j.path}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="row" style={{ marginTop: 10, alignItems: 'center' }}>
                <button className="btn btn-sm" onClick={detectJava} disabled={detecting}>
                  {detecting ? '扫描中…' : '刷新'}
                </button>
                <span className="muted small">重新搜索本机所有 Java(环境变量、注册表、常见安装目录、官方启动器运行时)。</span>
              </div>
            </div>
          )}
        </div>

        {settings.javaSelection === 'manual' && (
          <div className="field" style={{ marginBottom: 8 }}>
            <label className="field-label">手动指定 Java 路径</label>
            <input
              className="input"
              value={settings.javaPath}
              onChange={(e) => update({ javaPath: e.target.value })}
              placeholder="java.exe / javaw.exe 完整路径"
            />
            <span className="muted small">也可以直接点击上方列表中的某一项设为全局 Java。</span>
          </div>
        )}

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginTop: 4 }}>
          <div className="field-label" style={{ marginBottom: 8 }}>
            一键安装 Java(Adoptium Temurin)
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {JAVA_RUNTIME_MAJORS.map((major) => {
              const has = installedMajors.has(major);
              return (
                <button
                  key={major}
                  className={has ? 'btn' : 'btn btn-primary'}
                  onClick={() => installJava(major)}
                  disabled={installingMajor !== null}
                >
                  {has ? `Java ${major} ✓ 已安装` : `安装 Java ${major}`}
                </button>
              );
            })}
            <button className="btn" onClick={importJavaFile}>
              手动导入 Java…
            </button>
          </div>

          {/* Any other major (11–26 …), not limited to the presets above. */}
          <div className="row" style={{ marginTop: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="field" style={{ width: 150 }}>
              <label className="field-label">其他主版本</label>
              <input
                className="input"
                type="number"
                min={JAVA_MAJOR_MIN}
                max={JAVA_MAJOR_MAX}
                value={customMajor}
                onChange={(e) => setCustomMajor(e.target.value)}
                placeholder="例如 16"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void installCustomJava();
                }}
              />
            </div>
            <button className="btn" onClick={installCustomJava} disabled={installingMajor !== null || !customMajor.trim()}>
              安装该版本
            </button>
            <span className="muted small">
              支持 {JAVA_MAJOR_MIN}–{JAVA_MAJOR_MAX} 之间的任意主版本(如 11、16、18、22、24)。
            </span>
          </div>

          {installingMajor !== null && javaProgress && (
            <div style={{ marginTop: 12 }}>
              <div className="row-between">
                <span className="muted small">正在安装 Java {installingMajor}</span>
                <div className="row" style={{ gap: 8 }}>
                  <span className="muted small">
                    {formatBytes(javaProgress.downloadedBytes)} / {formatBytes(javaProgress.totalBytes)}
                  </span>
                  <button className="btn btn-danger" onClick={cancelJava}>
                    取消下载
                  </button>
                </div>
              </div>
              <div className="progress-track" style={{ marginTop: 6 }}>
                <div className="progress-fill" style={{ width: `${Math.round(javaProgress.progress * 100)}%` }} />
              </div>
              <p className="muted small" style={{ margin: '6px 0 0' }}>
                {javaProgress.task}
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-title">启动参数</div>
        <div className="row">
          <div className="field">
            <label className="field-label">最小内存 (MB)</label>
            <input className="input" type="number" value={settings.minMemory} onChange={(e) => update({ minMemory: Number(e.target.value) })} />
          </div>
          <div className="field">
            <label className="field-label">最大内存 (MB)</label>
            <input className="input" type="number" value={settings.maxMemory} onChange={(e) => update({ maxMemory: Number(e.target.value) })} />
          </div>
          <div className="field">
            <label className="field-label">分辨率</label>
            <div className="row" style={{ gap: 6 }}>
              <input className="input" type="number" value={settings.resolution.width} onChange={(e) => update({ resolution: { width: Number(e.target.value), height: settings.resolution.height } })} />
              <span className="muted">×</span>
              <input className="input" type="number" value={settings.resolution.height} onChange={(e) => update({ resolution: { width: settings.resolution.width, height: Number(e.target.value) } })} />
            </div>
          </div>
          <div className="field" style={{ justifyContent: 'flex-end' }}>
            <label className="field-label">全屏</label>
            <input type="checkbox" checked={settings.fullscreen} onChange={(e) => update({ fullscreen: e.target.checked })} />
          </div>
        </div>

        <div className="field" style={{ marginTop: 14 }}>
          <label className="field-label">额外 JVM 参数</label>
          <input className="input" value={settings.jvmArgs} onChange={(e) => update({ jvmArgs: e.target.value })} placeholder="例如 -XX:+UseG1GC (以空格分隔)" />
        </div>
      </div>
    </div>
  );
}
