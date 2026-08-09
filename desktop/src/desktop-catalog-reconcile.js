/**
 * AI:规范化 Desktop 目录中的线程标识并去重。
 *
 * @param {Array<{id?: string}>} threads Desktop 目录线程。
 * @returns {string[]} 线程标识。
 */
function catalogThreadIds(threads) {
  return Array.from(new Set((threads || []).map(thread => String(thread && thread.id || '').trim()).filter(Boolean)));
}

/**
 * AI:协调轻量 Desktop 目录结果与已映射 JSONL 目标。
 *
 * @param {{previousCatalogThreadIds?: string[], previousTargets?: object[], threads?: object[], discoverTargets: Function, forceDiscovery?: boolean}} options 协调参数。
 * @returns {{catalogThreadIds: string[], targets: object[], addedThreadIds: string[], removedThreadIds: string[], unresolvedThreadIds: string[], addedCount: number, removedCount: number, membershipChanged: boolean, orderChanged: boolean, discovered: boolean}} 协调结果。
 */
function reconcileDesktopCatalog(options = {}) {
  const previousCatalogThreadIds = catalogThreadIds((options.previousCatalogThreadIds || []).map(id => ({ id })));
  const nextCatalogThreadIds = catalogThreadIds(options.threads);
  const previousSet = new Set(previousCatalogThreadIds);
  const nextSet = new Set(nextCatalogThreadIds);
  const addedThreadIds = nextCatalogThreadIds.filter(id => !previousSet.has(id));
  const removedThreadIds = previousCatalogThreadIds.filter(id => !nextSet.has(id));
  const membershipChanged = Boolean(addedThreadIds.length || removedThreadIds.length);
  const previousTargets = options.previousTargets || [];
  const previousTargetIds = previousTargets.map(target => String(target && target.threadId || '').trim()).filter(Boolean);
  const previousTargetsById = new Map(previousTargets.map(target => [String(target && target.threadId || '').trim(), target]));
  const unresolvedThreadIds = nextCatalogThreadIds.filter(id => !previousTargetsById.has(id));
  const discovered = Boolean(addedThreadIds.length || (options.forceDiscovery && unresolvedThreadIds.length));
  let targets;

  if (discovered) {
    if (typeof options.discoverTargets !== 'function') throw new TypeError('缺少 Desktop JSONL 映射函数。');
    targets = options.discoverTargets(options.threads || []);
  } else {
    targets = nextCatalogThreadIds.map(id => previousTargetsById.get(id)).filter(Boolean);
  }
  const targetIds = targets.map(target => String(target && target.threadId || '').trim()).filter(Boolean);
  const orderChanged = previousTargetIds.length !== targetIds.length
    || previousTargetIds.some((id, index) => id !== targetIds[index]);

  return {
    catalogThreadIds: nextCatalogThreadIds,
    targets,
    addedThreadIds,
    removedThreadIds,
    unresolvedThreadIds,
    addedCount: addedThreadIds.length,
    removedCount: removedThreadIds.length,
    membershipChanged,
    orderChanged,
    discovered,
  };
}

module.exports = {
  catalogThreadIds,
  reconcileDesktopCatalog,
};
