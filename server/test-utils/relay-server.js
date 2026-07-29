/**
 * AI:终止 Relay 的升级连接和 HTTP 空闲连接，确保 Node 测试进程可以退出。
 *
 * @param {import('node:http').Server & {relayState?: {agents: Map<string, import('ws').WebSocket>, mobileClients: Map<string, Set<import('ws').WebSocket>>}} server Relay HTTP 服务。
 * @returns {Promise<void>} 服务关闭完成后兑现。
 */
function closeRelayServer(server) {
  const state = server.relayState;
  if (state) {
    for (const ws of state.agents.values()) ws.terminate();
    for (const clients of state.mobileClients.values()) {
      for (const ws of clients) ws.terminate();
    }
  }
  server.closeAllConnections();
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

module.exports = { closeRelayServer };
