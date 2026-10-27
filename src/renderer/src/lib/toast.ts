export type ToastType = 'info' | 'error' | 'success';

export interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

let listeners: Array<(t: Toast) => void> = [];
let nextId = 0;

export function notify(message: string, type: ToastType = 'info'): void {
  const t: Toast = { id: ++nextId, message, type };
  for (const l of listeners) l(t);
}

export function onToast(listener: (t: Toast) => void): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
