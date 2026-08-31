export function createManualIngestAdapter({ connected = false, fetchSnapshots = null } = {}) {
  const isConnected = connected === true && typeof fetchSnapshots === 'function';
  return {
    connected: isConnected,
    async loadPublishedPosts() {
      if (!isConnected) {
        return {
          connected: false,
          snapshots: [],
          note: 'Manual ingest adapter is unconnected. Do not claim human posts were read from Bridge or My-SNS.'
        };
      }
      const snapshots = await fetchSnapshots();
      return { connected: true, snapshots: snapshots || [], note: 'snapshots from adapter' };
    }
  };
}

export function publishedPostSnapshot({
  platform,
  text,
  humanAuthored = true,
  source = 'my-sns',
  at,
  entityName = null
} = {}) {
  return {
    kind: 'PublishedPostSnapshot',
    platform,
    text,
    humanAuthored: Boolean(humanAuthored),
    source,
    at,
    entityName
  };
}

export const __test = {};
