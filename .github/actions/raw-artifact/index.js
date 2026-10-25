const { createHash } = require('node:crypto');
const { readFile, appendFile } = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const { basename, resolve } = require('node:path');

const service = 'github.actions.results.api.v1.ArtifactService';
const blobMimeType = 'application/json\u0085';

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

function encodeVarint(value) {
  let n = BigInt(value);
  const bytes = [];
  while (n > 0x7fn) {
    bytes.push(Number(n & 0x7fn) | 0x80);
    n >>= 7n;
  }
  bytes.push(Number(n));
  return Buffer.from(bytes);
}

function encodeBytes(field, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  return Buffer.concat([encodeVarint((field << 3) | 2), encodeVarint(bytes.length), bytes]);
}

function decodeVarint(bytes, cursor) {
  let value = 0n;
  let shift = 0n;
  while (cursor.offset < bytes.length) {
    const byte = bytes[cursor.offset++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7n;
  }
  throw new Error('CreateArtifact protobuf response is truncated');
}

function parseCreateArtifactResponse(bytes) {
  const cursor = { offset: 0 };
  const result = { ok: false, signed_upload_url: '' };
  while (cursor.offset < bytes.length) {
    const tag = Number(decodeVarint(bytes, cursor));
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire === 0) {
      const value = decodeVarint(bytes, cursor);
      if (field === 1) result.ok = value !== 0n;
    } else if (wire === 2) {
      const length = Number(decodeVarint(bytes, cursor));
      const value = bytes.subarray(cursor.offset, cursor.offset + length);
      cursor.offset += length;
      if (field === 2) result.signed_upload_url = value.toString('utf8');
    } else {
      throw new Error(`Unexpected protobuf wire type ${wire}`);
    }
  }
  return result;
}

async function createArtifactWithRawMime(ids, name) {
  const resultsUrl = process.env.ACTIONS_RESULTS_URL;
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  const url = new URL(`/twirp/${service}/CreateArtifact`, new URL(resultsUrl).origin);
  const mimeValue = Buffer.concat([
    Buffer.from('application/json', 'ascii'),
    Buffer.from([0x85]),
  ]);
  const mimeWrapper = encodeBytes(1, mimeValue);
  const body = Buffer.concat([
    encodeBytes(1, ids.workflowRunBackendId),
    encodeBytes(2, ids.workflowJobRunBackendId),
    encodeBytes(3, name),
    encodeVarint((5 << 3) | 0), encodeVarint(7),
    encodeBytes(6, mimeWrapper),
  ]);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/protobuf',
      accept: 'application/protobuf',
    },
    body,
  });
  const raw = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(`Binary CreateArtifact failed with HTTP ${response.status}: ${raw.toString('utf8').slice(0, 500)}`);
  }
  let result;
  if ((response.headers.get('content-type') || '').includes('json')) {
    result = JSON.parse(raw.toString('utf8'));
  } else {
    result = parseCreateArtifactResponse(raw);
  }
  return result;
}

function putRawBlob(uploadUrl, body) {
  const url = new URL(uploadUrl);
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request({
      method: 'PUT',
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(body.length),
        'x-ms-blob-type': 'BlockBlob',
        'x-ms-blob-content-type': blobMimeType,
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

function setBlobContentType(uploadUrl) {
  const url = new URL(uploadUrl);
  const transport = url.protocol === 'https:' ? https : http;
  url.searchParams.set('comp', 'properties');
  return new Promise((resolve, reject) => {
    const request = transport.request({
      method: 'PUT',
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      headers: {
        'content-length': '0',
        'x-ms-blob-content-type': blobMimeType,
        'x-ms-version': '2022-11-02',
      },
    }, response => {
      response.resume();
      response.on('end', () => {
        resolve(response.statusCode || 500);
      });
    });
    request.on('error', () => reject(new Error('Blob property update transport failed')));
    request.end();
  });
}

async function main() {
  const file = resolve(process.env.GITHUB_WORKSPACE || process.cwd(), process.env.INPUT_PATH || '');
  const payload = JSON.parse(await readFile(file, 'utf8'));
  const ids = runtimeIds(process.env.ACTIONS_RUNTIME_TOKEN || '');
  const name = basename(file);
  const created = await createArtifactWithRawMime(ids, name);
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
  const propertyStatus = await setBlobContentType(uploadUrl);
  console.log(`SET_BLOB_CONTENT_TYPE_HTTP=${propertyStatus}`);

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `artifact-id=${finalizedId}\n`);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

