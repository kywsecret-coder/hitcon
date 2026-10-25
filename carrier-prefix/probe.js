'use strict';

const https = require('node:https');
const { createHash } = require('node:crypto');

function request(urlText, headers = {}) {
  const url = new URL(urlText);
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'GET', hostname: url.hostname, port: url.port || 443,
      path: `${url.pathname}${url.search}`, headers,
    }, res => {
      const chunks = [];
      res.on('data', x => chunks.push(x));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.rawHeaders, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function header(raw, wanted) {
  for (let i = 0; i < raw.length; i += 2) if (raw[i].toLowerCase() === wanted) return raw[i + 1];
  return '';
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const id = process.env.ARTIFACT_ID;
  const token = process.env.GH_TOKEN;
  if (!repo || !/^\d+$/.test(id || '') || !token) throw new Error('Artifact read context is missing');
  const first = await request(`https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`, {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'repo-cassette-nel-prefix-probe',
  });
  const location = header(first.headers, 'location');
  if (first.status !== 302 || !location) throw new Error(`Artifact download returned HTTP ${first.status}`);
  const final = await request(location);
  const type = header(final.headers, 'content-type');
  const payload = {
    full_name: `${repo}/actions/artifacts/${id}/zip`,
    owner: { login: 'cassette', avatar_url: 'file:///proc/self/environ' },
    description: 'Repo Cassette nested raw artifact candidate',
    stargazers_count: 0,
  };
  const expected = Buffer.from(JSON.stringify(payload));
  const report = {
    apiStatus: first.status,
    blobStatus: final.status,
    contentTypeCodepoints: Array.from(type).map(x => x.codePointAt(0).toString(16)).join(','),
    contentTypeLatin1Hex: Buffer.from(type, 'latin1').toString('hex'),
    bodyBytes: final.body.length,
    bodySha256: createHash('sha256').update(final.body).digest('hex'),
    exactBody: final.body.equals(expected),
    pythonAcceptsNodeHashes: type === '\u0085application/json',
  };
  console.log(`MIME_PROBE=${JSON.stringify(report)}`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

