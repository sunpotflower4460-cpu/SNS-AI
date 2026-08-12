const RELEASE_TAG = 'sns-ai-media';

export function githubToken() { return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ''; }
export function repoName() { return process.env.GITHUB_REPOSITORY || ''; }

export async function githubApi(path, options = {}) {
  const token = githubToken();
  const repo = repoName();
  if (!token || !repo) throw new Error('Built-in media hosting requires GITHUB_TOKEN/GH_TOKEN and GITHUB_REPOSITORY.');
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.message || `GitHub API failed with ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

export async function ensurePublicRelease() {
  const repo = repoName();
  const metadata = await githubApi(`/repos/${repo}`);
  if (metadata.private) throw new Error('Built-in GitHub media hosting requires a public repository. For a private repository, configure media.endpoint/CDN instead.');
  try {
    return await githubApi(`/repos/${repo}/releases/tags/${encodeURIComponent(RELEASE_TAG)}`);
  } catch (error) {
    if (error.status !== 404) throw error;
    try {
      return await githubApi(`/repos/${repo}/releases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tag_name: RELEASE_TAG,
          target_commitish: process.env.GITHUB_REF_NAME || 'main',
          name: 'SNS-AI generated media',
          body: 'Automatically generated media assets used by SNS-AI. Managed by GitHub Actions.',
          draft: false,
          prerelease: false
        })
      });
    } catch (createError) {
      if (createError.status !== 422) throw createError;
      return githubApi(`/repos/${repo}/releases/tags/${encodeURIComponent(RELEASE_TAG)}`);
    }
  }
}

export async function listAllAssets(releaseId) {
  const assets = [];
  for (let page = 1; page <= 50; page += 1) {
    const batch = await githubApi(`/repos/${repoName()}/releases/${releaseId}/assets?per_page=100&page=${page}`);
    assets.push(...batch);
    if (batch.length < 100) break;
  }
  return assets;
}

export async function findAsset(release, name) {
  const existing = (release.assets || []).find((asset) => asset.name === name);
  if (existing?.browser_download_url) return existing.browser_download_url;
  const assets = await listAllAssets(release.id);
  return assets.find((asset) => asset.name === name)?.browser_download_url || null;
}

export async function uploadReleaseAsset(release, name, bytes, contentType) {
  const token = githubToken();
  const repo = repoName();
  const url = `https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': contentType || 'application/octet-stream',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: bytes
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 422) {
      const cached = await findAsset(release, name);
      if (cached) return cached;
    }
    throw new Error(body?.message || `GitHub release asset upload failed with ${response.status}`);
  }
  if (!body.browser_download_url) throw new Error('GitHub release asset upload returned no public download URL.');
  return body.browser_download_url;
}

export async function cleanupGeneratedAssets({ retentionDays = 90 } = {}) {
  if (!githubToken() || !repoName()) return { skipped: true, reason: 'GitHub runtime credentials unavailable', deleted: 0 };
  let release;
  try { release = await githubApi(`/repos/${repoName()}/releases/tags/${encodeURIComponent(RELEASE_TAG)}`); }
  catch (error) { if (error.status === 404) return { skipped: true, reason: 'No generated-media release exists', deleted: 0 }; throw error; }
  const cutoff = Date.now() - Math.max(1, Number(retentionDays)) * 86_400_000;
  const assets = await listAllAssets(release.id);
  const old = assets.filter((asset) => Date.parse(asset.created_at || '') < cutoff);
  let deleted = 0;
  for (const asset of old) {
    const response = await fetch(`https://api.github.com/repos/${repoName()}/releases/assets/${asset.id}`, {
      method: 'DELETE',
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${githubToken()}`, 'X-GitHub-Api-Version': '2022-11-28' }
    });
    if (!response.ok && response.status !== 404) throw new Error(`Could not delete old generated media asset ${asset.id}: HTTP ${response.status}`);
    deleted += 1;
  }
  return { skipped: false, scanned: assets.length, deleted };
}
