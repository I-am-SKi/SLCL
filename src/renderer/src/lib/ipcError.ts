/**
 * Electron wraps failures thrown inside an IPC handler as:
 *
 *   Error invoking remote method 'slcl:slatt:login': Error: 用户名或密码错误
 *
 * Showing that to the user leaks an internal channel name and reads like a crash.
 * Every IPC call in this app funnels through `notify(e.message)`, so unwrap it in
 * one place instead of per call site.
 */
const IPC_PREFIX = /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/;

export function ipcErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const unwrapped = raw.replace(IPC_PREFIX, '').trim();
  return unwrapped || '发生未知错误';
}
