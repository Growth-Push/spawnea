import type { SpawneaApi } from './index';

declare global {
  interface Window {
    spawneaApi: SpawneaApi;
  }
}
