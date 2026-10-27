import { useEffect, useState, type JSX } from 'react';

/**
 * Global two-step confirmation for destructive actions.
 *
 * Any renderer module can `await confirmAction({...})`; the modal is rendered once
 * by `<ConfirmHost />` (mounted in App). This keeps every delete flow - version,
 * account, resource file, screenshot - behind the same explicit confirmation.
 */
export interface ConfirmOptions {
  title: string;
  message: string;
  /** Label of the destructive button. Defaults to 确认删除. */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as dangerous (default true). */
  danger?: boolean;
}

interface PendingConfirm {
  options: ConfirmOptions;
  resolve: (value: boolean) => void;
}

let pending: PendingConfirm | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Show a confirmation modal. Resolves true when the user confirms. */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  // Replacing an existing prompt resolves the old one as cancelled (never leaves it hanging).
  if (pending) {
    pending.resolve(false);
    pending = null;
  }
  return new Promise<boolean>((resolve) => {
    pending = { options, resolve };
    emit();
  });
}

function resolvePending(value: boolean): void {
  const p = pending;
  pending = null;
  emit();
  p?.resolve(value);
}

export function ConfirmHost(): JSX.Element | null {
  const [current, setCurrent] = useState<PendingConfirm | null>(pending);

  useEffect(() => {
    const cb = (): void => setCurrent(pending);
    listeners.add(cb);
    cb();
    return () => {
      listeners.delete(cb);
    };
  }, []);

  // Esc cancels — destructive actions should never be confirmed by a stray key.
  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') resolvePending(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current]);

  if (!current) return null;
  const { title, message, confirmLabel = '确认删除', cancelLabel = '取消', danger = true } = current.options;

  return (
    <div className="modal-backdrop confirm-backdrop" onClick={() => resolvePending(false)}>
      <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{title}</div>
        <p className="confirm-message">{message}</p>
        <div className="dialog-actions">
          <button className="btn" onClick={() => resolvePending(false)}>
            {cancelLabel}
          </button>
          <button
            className={danger ? 'btn btn-danger-solid' : 'btn btn-primary'}
            onClick={() => resolvePending(true)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
