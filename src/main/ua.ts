/**
 * Single source of truth for the launcher's HTTP User-Agent.
 *
 * Format is `SLCL/{version}` — the name/version shape MCIM asks for when
 * registering an integrator (mcmod-info-mirror/mcim-rust-api#12). The mirror may
 * later enforce a UA allowlist, so:
 *
 *   - the name `SLCL` must never change;
 *   - the version follows package.json automatically, no manual bumps;
 *   - every outbound request must send it (never an empty UA, never Node's
 *     default `node`/`undici` UA).
 */
import { app } from 'electron';

export function userAgent(): string {
  return `SLCL/${app.getVersion()}`;
}
