import { useEffect, useState, type JSX } from 'react';
import type { CrashInfo } from '@shared/types';
import { notify } from '../lib/toast';

/**
 * Crash report dialog.
 *
 * Mounted once by `<App />` and driven by a module-level queue, mirroring
 * `ConfirmDialog`. A crash can happen while the user is on any page, so the
 * dialog must not live inside the Home page.
 *
 * Three actions, matching what a user actually needs after a failed launch:
 *   - 确认          close and go look at the game themselves
 *   - 查看输出      open the real game log in the OS default viewer
 *   - 导出错误报告  save a self-contained report (diagnosis + full logs)
 */

type QueueListener = () => void;

let queue: CrashInfo[] = [];
const listeners = new Set<QueueListener>();

function emit(): void {
  for (const l of listeners) l();
}

/** Show the crash dialog for `info`. Safe to call repeatedly. */
export function showCrashReport(info: CrashInfo): void {
  queue = [...queue, info];
  emit();
}

function dismiss(): void {
  queue = queue.slice(1);
  emit();
}

const SEVERITY_LABEL: Record<string, string> = {
  error: '致命',
  warning: '警告',
  info: '提示',
};

export function CrashDialogHost(): JSX.Element | null {
  const [current, setCurrent] = useState<CrashInfo | null>(queue[0] ?? null);
  const [busy, setBusy] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    const cb = (): void => {
      setCurrent(queue[0] ?? null);
      setShowDetails(false);
    };
    listeners.add(cb);
    cb();
    return () => {
      listeners.delete(cb);
    };
  }, []);

  // Escape closes the dialog, like every other modal in the app.
  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current]);

  if (!current) return null;

  async function openLog(): Promise<void> {
    setBusy(true);
    try {
      const ok = await window.slcl.crash.openLog();
      if (!ok) notify('没有找到这次启动的日志文件', 'error');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function exportReport(): Promise<void> {
    setBusy(true);
    try {
      const path = await window.slcl.crash.exportReport();
      if (path) notify(`错误报告已保存到 ${path}`, 'success');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  const primary = current.findings[0];
  const rest = current.findings.slice(1);

  return (
    <div className="modal-backdrop" role="presentation" onClick={dismiss}>
      <div
        className="modal crash-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="crash-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="crash-head">
          <span className="crash-icon" aria-hidden="true">
            !
          </span>
          <div>
            <div className="modal-title" id="crash-title">
              游戏启动失败
            </div>
            <p className="muted small crash-sub">
              版本 {current.versionId}
              {current.exitCode !== null && ` · 退出码 ${current.exitCode}`}
              {current.modCount !== null && ` · 已加载 ${current.modCount} 个模组`}
            </p>
          </div>
        </div>

        {primary && (
          <div className="crash-finding">
            <div className="crash-finding-title">
              <span className={`crash-badge ${primary.severity}`}>{SEVERITY_LABEL[primary.severity]}</span>
              {primary.title}
            </div>
            <p className="crash-finding-detail">{primary.detail}</p>
            <p className="crash-finding-action">
              <strong>建议：</strong>
              {primary.action}
            </p>
          </div>
        )}

        {rest.length > 0 && (
          <div className="crash-more">
            <button className="link-btn" onClick={() => setShowDetails((v) => !v)}>
              {showDetails ? '收起其他分析' : `查看其他 ${rest.length} 条分析`}
            </button>
            {showDetails &&
              rest.map((f) => (
                <div className="crash-finding secondary" key={f.id}>
                  <div className="crash-finding-title">
                    <span className={`crash-badge ${f.severity}`}>{SEVERITY_LABEL[f.severity]}</span>
                    {f.title}
                  </div>
                  <p className="crash-finding-detail">{f.detail}</p>
                  <p className="crash-finding-action">
                    <strong>建议：</strong>
                    {f.action}
                  </p>
                </div>
              ))}
          </div>
        )}

        <p className="muted small crash-hint">
          导出的错误报告包含诊断结论、Minecraft 崩溃报告与完整游戏日志，可直接发给开发者排查。
        </p>

        <div className="dialog-actions crash-actions">
          <button className="btn" onClick={dismiss} disabled={busy}>
            确认
          </button>
          <button className="btn" onClick={() => void openLog()} disabled={busy}>
            查看输出
          </button>
          <button className="btn btn-primary" onClick={() => void exportReport()} disabled={busy}>
            导出错误报告
          </button>
        </div>
      </div>
    </div>
  );
}
