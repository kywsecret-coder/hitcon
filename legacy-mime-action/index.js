const https = require('node:https');
const {createHash} = require('node:crypto');
const {appendFile} = require('node:fs/promises');

const repository = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID;
const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
if (!runtimeToken || !process.env.ACTIONS_RESULTS_URL) {
  throw new Error('Actions Results runtime is unavailable to the JavaScript action');
}

const scope = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url').toString()).scp
  .split(' ').find(value => value.startsWith('Actions.Results:'));
const ids = scope.split(':');
const service = 'github.actions.results.api.v1.ArtifactService';
const runtimeOrigin = new URL(process.env.ACTIONS_RESULTS_URL).origin;
const blobContentType = 'application/json\u0085';
const artifactIds = [];

function rawRequest(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = https.request({
      method,
      hostname: target.hostname,
      port: target.port || 443,
      path: target.pathname + target.search,
      headers,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    request.on('error', reject);
    request.setTimeout(30000, () => request.destroy(new Error('request timeout')));
    if (body) request.write(body);
    request.end();
  });
}

async function rpc(method, body) {
  const response = await fetch(new URL('/twirp/' + service + '/' + method, runtimeOrigin), {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + runtimeToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error('rpc-' + method + '-' + response.status);
  return response.json();
}

async function uploadBlob(url, body) {
  return rawRequest(url, 'PUT', {
    'content-type': 'application/octet-stream',
    'content-length': String(body.length),
    'x-ms-blob-type': 'BlockBlob',
    'x-ms-blob-content-type': blobContentType,
    'x-ms-version': '2022-11-02',
  }, body);
}

async function main() {
  for (const version of [1, 2, 3, 4, 5, 6]) {
    const name = 'legacy-v' + version + '-' + runId;
    const created = await rpc('CreateArtifact', {
      workflow_run_backend_id: ids[1],
      workflow_job_run_backend_id: ids[2],
      name,
      version,
    });
    const uploadUrl = created.signed_upload_url || created.signedUploadUrl;
    if (!created.ok || !uploadUrl) throw new Error('CreateArtifact-rejected-v' + version);

    const payload = {
      full_name: 'placeholder/repository',
      owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
      description: 'Repo Cassette legacy blob MIME discriminator',
      stargazers_count: 0,
    };
    const initialBody = Buffer.from(JSON.stringify(payload));
    const initialUpload = await uploadBlob(uploadUrl, initialBody);
    if (initialUpload.status < 200 || initialUpload.status >= 300) {
      throw new Error('blob-upload-v' + version + '-' + initialUpload.status);
    }

    const digest = createHash('sha256').update(initialBody).digest('hex');
    const finalized = await rpc('FinalizeArtifact', {
      workflow_run_backend_id: ids[1],
      workflow_job_run_backend_id: ids[2],
      name,
      size: String(initialBody.length),
      hash: 'sha256:' + digest,
    });
    const artifactId = finalized.artifact_id || finalized.artifactId;
    if (!finalized.ok || !artifactId) throw new Error('FinalizeArtifact-rejected-v' + version);

    payload.full_name = repository + '/actions/artifacts/' + artifactId + '/zip';
    const finalBody = Buffer.from(JSON.stringify(payload));
    const overwrite = await uploadBlob(uploadUrl, finalBody);
    if (overwrite.status < 200 || overwrite.status >= 300) {
      throw new Error('blob-overwrite-v' + version + '-' + overwrite.status);
    }
    artifactIds.push(artifactId);
    console.log('LEGACY-UPLOAD ' + JSON.stringify({
      version,
      artifactId,
      bytes: finalBody.length,
      bodySha256: createHash('sha256').update(finalBody).digest('hex'),
      uploadContentTypeHex: Buffer.from(blobContentType, 'latin1').toString('hex'),
    }));
  }
  await appendFile(process.env.GITHUB_OUTPUT, 'artifact_ids=' + JSON.stringify(artifactIds) + '\n');
}

main().catch(error => {
  console.error(JSON.stringify({name: error.name, message: error.message}));
  process.exitCode = 1;
});
