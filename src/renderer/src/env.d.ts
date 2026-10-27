/// <reference types="vite/client" />

import type { SlclApi } from '@shared/api';

declare global {
  interface Window {
    slcl: SlclApi;
  }
}

export {};
