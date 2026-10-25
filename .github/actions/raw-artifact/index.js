const { createHash } = require('node:crypto');
const { readFile, appendFile } = require('node:fs/promises');
const { basename, resolve } = require('node:path');

const service = 'github.actions.results.api.v1.ArtifactService';
const mimeType = 'application/json\u0085';

function runtimeIds(token) {
  const part = token.split('.')[1];
  if (!part) throw new Error('Actions runtime token is malformed');
  const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  const scope = String(claims.scp || '').split(' ').find(x => x.startsWith('Actions.Results:'));
  const fields = scope?.split(':');
  if (!fields || fields.length !== 3) throw new Error('Actions Results scope is missing');
  return { workflowRunBackendId: fields[1], workflowJobRunBackendId: fields[2] };
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

async function main() {
  const file = resolve(process.env.GITHUB_WORKSPACE || process.cwd(), process.env.INPUT_PATH || '');
  const payload = JSON.parse(await readFile(file, 'utf8'));
  const ids = runtimeIds(process.env.ACTIONS_RUNTIME_TOKEN || '');
  const name = basename(file);
  const created = await rpc('CreateArtifact', {
    workflow_run_backend_id: ids.workflowRunBackendId,
    workflow_job_run_backend_id: ids.workflowJobRunBackendId,
    name,
    version: 7,
    mime_type: { value: mimeType },
  });
  const uploadUrl = created.signed_upload_url || created.signedUploadUrl;
  if (!created.ok || !uploadUrl) throw new Error('CreateArtifact returned no upload URL');

  const listed = await rpc('ListArtifacts', {
    workflow_run_backend_id: ids.workflowRunBackendId,
    workflow_job_run_backend_id: ids.workflowJobRunBackendId,
    name_filter: { value: name },
  });
  const record = (listed.artifacts || []).find((artifact) => artifact.name === name);
  const artifactId = record?.database_id || record?.databaseId;
  if (!artifactId) throw new Error('ListArtifacts did not expose the pending artifact ID');

  payload.full_name = `${process.env.GITHUB_REPOSITORY}/actions/artifacts/${artifactId}/zip`;
  const body = Buffer.from(JSON.stringify(payload));

  const uploaded = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'content-type': 'application/octet-stream',
      'x-ms-blob-type': 'BlockBlob',
      'x-ms-blob-content-type': mimeType,
      'x-ms-version': '2022-11-02',
    },
    body,
  });
  if (!uploaded.ok) throw new Error(`Blob upload failed with HTTP ${uploaded.status}`);

  const digest = createHash('sha256').update(body).digest('hex');
  const finalized = await rpc('FinalizeArtifact', {
    workflow_run_backend_id: ids.workflowRunBackendId,
    workflow_job_run_backend_id: ids.workflowJobRunBackendId,
    name,
    size: String(body.length),
    hash: { value: `sha256:${digest}` },
  });
  const finalizedId = finalized.artifact_id || finalized.artifactId;
  if (!finalized.ok || !finalizedId) throw new Error('FinalizeArtifact returned no artifact ID');
  if (String(finalizedId) !== String(artifactId)) {
    throw new Error(`Artifact ID changed during finalization (${artifactId} -> ${finalizedId})`);
  }

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `artifact-id=${finalizedId}\n`);
  }
  console.log(`ARTIFACT_ID=${finalizedId}`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
