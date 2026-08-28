import { fetchJson } from '../../lib/http.mjs';
import { normalizeCandidate } from './normalize.mjs';

// api.github.com is a fixed, trusted host (identical to src/lib/github.mjs), so a plain fetchJson
// against it does not need the SSRF-hardened fetchPublicHttps used for arbitrary per-source RSS URLs
// in rss.mjs. An unauthenticated request works for public repositories; an optional token (already
// available to GitHub Actions runs) only raises the rate limit.
function githubHeaders() {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export async function fetchGithubReleasesSource(source) {
  const owner = source?.owner;
  const repo = source?.repo;
  if (!owner || !repo) throw new Error(`GitHub releases source ${source?.id || '(unknown)'} is missing owner/repo.`);
  const perPage = Number(source.maxItems || 10);
  const releases = await fetchJson(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=${perPage}`, {
    headers: githubHeaders()
  });
  const fetchedAt = new Date().toISOString();
  return (Array.isArray(releases) ? releases : [])
    .filter((release) => !release.draft)
    .map((release) => normalizeCandidate({
      sourceId: source.id,
      sourceType: 'github-releases',
      title: release.name || release.tag_name || `${owner}/${repo} release`,
      url: release.html_url,
      publishedAt: release.published_at || release.created_at || null,
      fetchedAt,
      vendor: source.vendor || owner,
      product: source.product || repo,
      summary: String(release.body || '').slice(0, 2000),
      rawText: release.body || '',
      categories: source.categories || [],
      metadata: { version: release.tag_name || null, prerelease: Boolean(release.prerelease) }
    }));
}

export const __test = { githubHeaders };
