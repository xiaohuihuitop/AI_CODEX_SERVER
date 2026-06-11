import { createSSRApp } from 'vue';
import App from './App.vue';

/**
 * AI:创建 uni-app Vue 应用实例。
 *
 * @returns {{app: import('vue').App}} uni-app 应用对象。
 */
export function createApp() {
  const app = createSSRApp(App);
  return { app };
}
