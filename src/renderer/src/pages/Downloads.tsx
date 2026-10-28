import { useEffect, useState, type JSX } from 'react';
import { clearHistory, useDownloadState, type ActiveDownload } from '../lib/download';
import { formatBytes } from '../lib/toast';

/**
 * 下载管理
 *
 * One place to see what the launcher is currently downloading: overall progress,
 * live transfer rate, file counts and the file in flight, plus the recent history.
 * The main process throttles its progress events to ~5/s, so every value here is
 * already safe to render directly.
 */
export default function Downloads(): JSX.Element {
  const { active, history } = useDownloadState();

  return (
    <div>
      <div className="row-between" style={{ alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">下载管理</h1>
          <p className="page-subtitle">查看正在进行的下载任务与历史记录。</p>
        </div>
        {history.length > 0 && (
          <button className="btn btn-sm" onClick={() => clearHistory()}>
            清空历史
          </button>
        )}
      </div>

      {active ? <ActiveTask task={active} /> : <IdleState />}

      {history.length > 0 && (
        <div className="card">
          <div className="card-title">历史记录</div>
          <div className="dl-history">
            {history.map((h) => (
              <div className="dl-history-row" key={`${h.id}-${h.finishedAt}`}>
                <span className={`dl-history-dot${h.ok ? ' ok' : ' fail'}`} aria-hidden="true" />
                <div className="dl-history-main">
                  <div className="dl-history-name" title={h.id}>
                    {h.id}
                  </div>
                  <div className="muted small">
                    {h.kind === 'install' ? '安装' : '修复'} · {formatDuration(h.durationMs)}
                    {h.bytes > 0 && ` · ${formatBytes(h.bytes)}`}
                  </div>
                  {!h.ok && h.error && <div className="dl-history-error">{h.error}</div>}
                </div>
                <span className={`badge${h.ok ? ' badge-accent' : ''}`}>
                  {h.ok ? '完成' : '失败'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function IdleState(): JSX.Element {
  return (
    <div className="card">
      <div className="dl-idle">
        <span className="dl-idle-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3v12m0 0l4-4m-4 4l-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
          </svg>
        </span>
        <div className="dl-idle-title">当前没有下载任务</div>
        <p className="muted small" style={{ margin: '6px 0 0' }}>
          在「资源下载」或「版本管理」中开始安装后，进度会显示在这里。
        </p>
      </div>
    </div>
  );
}

function ActiveTask({ task }: { task: ActiveDownload }): JSX.Element {
  const { progress, speed, startedAt } = task;
  const pct = Math.max(0, Math.min(100, Math.round(progress.progress * 100)));

  // Drives the elapsed counter and the "speed is stale" hint.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const totalFiles = progress.totalFiles ?? 0;
  const doneFiles = progress.completedFiles ?? 0;
  const remainingFiles = Math.max(0, totalFiles - doneFiles);
  const hasFiles = totalFiles > 0;

  // No bytes moved for a while: show a hint instead of a frozen 0 B/s with no
  // explanation. Mirrors the main process's stall timeout (20s).
  const stalled = speed === 0 && progress.progress > 0 && progress.progress < 1;

  return (
    <div className="card dl-task">
      <div className="row-between" style={{ alignItems: 'flex-start', marginBottom: 14 }}>
        <div style={{ minWidth: 0 }}>
          <div className="dl-task-name" title={task.id}>
            {task.id}
          </div>
          <div className="muted small" style={{ marginTop: 3 }}>
            {task.kind === 'install' ? '正在安装' : '正在修复'} · 已用时 {formatDuration(Date.now() - startedAt)}
          </div>
        </div>
        <button className="btn btn-danger btn-sm" onClick={() => void window.slcl.versions.cancel()}>
          取消下载
        </button>
      </div>

      <div className="dl-progress-head">
        <span className="dl-pct">{pct}%</span>
        <span className="muted small">
          {formatBytes(progress.downloadedBytes)}
          {progress.totalBytes > 0 && ` / ${formatBytes(progress.totalBytes)}`}
        </span>
      </div>
      <div className="progress-track dl-track" style={{ marginTop: 8 }}>
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>

      <div className="dl-stats">
        <Stat label="当前速度" value={speed > 0 ? `${formatBytes(speed)}/s` : stalled ? '等待中…' : '—'} accent={speed > 0} />
        <Stat label="文件总数" value={hasFiles ? String(totalFiles) : '—'} />
        <Stat label="剩余文件" value={hasFiles ? String(remainingFiles) : '—'} />
        <Stat label="已完成" value={hasFiles ? `${doneFiles} / ${totalFiles}` : '—'} />
      </div>

      <div className="dl-current" title={progress.task}>
        <span className="dl-current-label">当前</span>
        <span className="dl-current-text">{progress.task}</span>
      </div>

      {stalled && (
        <p className="dl-stall-hint">
          连接暂时没有数据到达，正在等待或自动重试。若长时间无进展，可取消后重新开始。
        </p>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }): JSX.Element {
  return (
    <div className="dl-stat">
      <div className="dl-stat-label">{label}</div>
      <div className={`dl-stat-value${accent ? ' accent-text' : ''}`}>{value}</div>
    </div>
  );
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
