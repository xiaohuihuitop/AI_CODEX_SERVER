const { defineConfig } = require('vite');
const uni = require('@dcloudio/vite-plugin-uni').default;

module.exports = defineConfig({
  plugins: [uni()],
});
