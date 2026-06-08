const { createDesktopManagerServer } = require('./src/desktop-manager-server');

const PORT = Number(process.env.CODEX_MANAGER_PORT || 8790);
const HOST = process.env.CODEX_MANAGER_HOST || '127.0.0.1';

const server = createDesktopManagerServer();
server.listen(PORT, HOST, () => {
  console.log('Codex Desktop Manager is running.');
  console.log(`  http://${HOST}:${PORT}`);
});
