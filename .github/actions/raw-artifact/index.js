const { createHash } = require('node:crypto');
const { readFile, appendFile } = require('node:fs/promises');
const https = require('node:https');
const { basename, resolve } = require('node:path');

const service = 'github.actions.results.api.v1.ArtifactService';
const artifactMimeType = process.env.INPUT_MIME_TYPE || '';
const blobMimeType = process.env.INPUT_BLOB_MIME_TYPE || '';

function runtimeIds(token) {
  const part = token.split('.')[1];
  if (!part) throw new Error('Actions runtime token is malformed');
  const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  const scope = String(claims.scp || '').split(' ').find(x => x.startsWith('Actions.Results:'));
  const fields = scope?.split(':');
  if (!fields || fields.length !== 3) throw new Error('Actions Results scope is missing');
  return { workflowRunBackendId: fields[1], workflowJobRunBackendId: fields[2] };
}

async function rpcRaw(method, rawBody) {
  const resultsUrl = process.env.ACTIONS_RESULTS_URL;
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  if (!resultsUrl || !token) throw new Error('Actions artifact runtime is unavailable');
  const url = new URL(`/twirp/${service}/${method}`, new URL(resultsUrl).origin);
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: rawBody,
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1000);
    throw new Error(`${method} failed with HTTP ${response.status}: ${detail}`);
  }
  return response.json();
}

async function rpc(method, body) {
  const resultsUrl = process.env.ACTIONS_RESULTS_URL;
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  if (!resultsUrl || !token) throw new Error('Actions artifact runtime is unavailable');
  const url = new URL(`/twirp/${service}/${method}`, new URL(resultsUrl).origin);
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1000);
    throw new Error(`${method} failed with HTTP ${response.status}: ${detail}`);
  }
  return response.json();
}

function putRawBlob(uploadUrl, body) {
  const url = new URL(uploadUrl);
  return new Promise((resolve, reject) => {
    const request = https.request({
      method: 'PUT',
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(body.length),
        'x-ms-blob-type': 'BlockBlob',
        ...(blobMimeType ? { 'x-ms-blob-content-type': blobMimeType } : {}),
        'x-ms-version': '2022-11-02',
      },
    }, response => {
      response.resume();
      response.on('end', () => {
        if ((response.statusCode || 500) < 200 || (response.statusCode || 500) >= 300) {
          reject(new Error(`Blob upload failed with HTTP ${response.statusCode}`));
          return;
        }
        resolve(response.statusCode);
      });
    });
    request.on('error', () => reject(new Error('Blob upload transport failed')));
    request.end(body);
  });
}

async function main() {
  const file = resolve(process.env.GITHUB_WORKSPACE || process.cwd(), process.env.INPUT_PATH || '');
  const payload = JSON.parse(await readFile(file, 'utf8'));
  const ids = runtimeIds(process.env.ACTIONS_RUNTIME_TOKEN || '');
  const name = basename(file);
  const createBody = {
    workflow_run_backend_id: ids.workflowRunBackendId,
    workflow_job_run_backend_id: ids.workflowJobRunBackendId,
    name,
    version: 7,
  };
  let created;
  if (process.env.INPUT_MIME_TYPE_ALIAS && artifactMimeType) {
    const rawBody = JSON.stringify(createBody).slice(0, -1) +
      `,"mime_type":${JSON.stringify(artifactMimeType)},"mimeType":${JSON.stringify(process.env.INPUT_MIME_TYPE_ALIAS)}}`;
    created = await rpcRaw('CreateArtifact', rawBody);
  } else {
    if (artifactMimeType) createBody.mime_type = artifactMimeType;
    created = await rpc('CreateArtifact', createBody);
  }
  const uploadUrl = created.signed_upload_url || created.signedUploadUrl;
  if (!created.ok || !uploadUrl) throw new Error('CreateArtifact returned no upload URL');

  // The Results API does not expose a pending artifact in ListArtifacts. Upload
  // a placeholder once to finalize and learn the assigned ID, then test whether
  // the still-live upload URL permits replacing its raw body with the final
  // repository-shaped response.
  payload.full_name = `${process.env.GITHUB_REPOSITORY}/actions/artifacts/pending/zip`;
  const body = Buffer.from(JSON.stringify(payload));

  await putRawBlob(uploadUrl, body);

  const digest = createHash('sha256').update(body).digest('hex');
  const finalized = await rpc('FinalizeArtifact', {
    workflow_run_backend_id: ids.workflowRunBackendId,
    workflow_job_run_backend_id: ids.workflowJobRunBackendId,
    name,
    size: String(body.length),
    hash: `sha256:${digest}`,
  });
  const finalizedId = finalized.artifact_id || finalized.artifactId;
  if (!finalized.ok || !finalizedId) throw new Error('FinalizeArtifact returned no artifact ID');

  console.log(`ARTIFACT_ID=${finalizedId}`);
  payload.full_name = `${process.env.GITHUB_REPOSITORY}/actions/artifacts/${finalizedId}/zip`;
  const finalBody = Buffer.from(JSON.stringify(payload));
  const overwriteStatus = await putRawBlob(uploadUrl, finalBody);
  console.log(`POST_FINALIZE_REUPLOAD_HTTP=${overwriteStatus}`);
  console.log(`POST_FINALIZE_REUPLOAD_BYTES=${finalBody.length}`);

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `artifact-id=${finalizedId}\n`);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

