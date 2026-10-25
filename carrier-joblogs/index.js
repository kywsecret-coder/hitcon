'use strict';

const https = require('node:https');
const { createHash } = require('node:crypto');
const { appendFile } = require('node:fs/promises');

const mime = 'application/json\u0085';

function out(key, value) {
  console.log(`${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) {
    return appendFile(process.env.GITHUB_OUTPUT, `${key.toLowerCase().replaceAll('_', '-')}=${value}\n`);
  }
}

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
  const base = process.env.ACTIONS_RESULTS_URL;
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  if (!base || !token) throw new Error('Actions Results runtime is unavailable');
  const url = new URL(`/twirp/results.services.receiver.Receiver/${method}`, new URL(base).origin);
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} failed with HTTP ${response.status}`);
  try { return JSON.parse(text); } catch { return {}; }
}

function upload(urlText, body) {
  const url = new URL(urlText);
  return new Promise((resolve, reject) => {
    const request = https.request({
      method: 'PUT',
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      headers: {
        'content-length': String(body.length),
        'x-ms-blob-type': 'BlockBlob',
        'x-ms-version': '2022-11-02',
        'content-type': mime,
      },
    }, response => {
      response.resume();
      response.on('end', () => {
        if ((response.statusCode || 500) < 200 || (response.statusCode || 500) >= 300) {
          reject(new Error(`Job log blob upload failed with HTTP ${response.statusCode}`));
        } else resolve(response.statusCode);
      });
    });
    request.on('error', error => reject(new Error(`Job log blob upload failed: ${error.code || 'transport'}`)));
    request.end(body);
  });
}

function rawRequest(urlText, headers = {}) {
  const url = new URL(urlText);
  const transport = url.protocol === 'http:' ? require('node:http') : https;
  return new Promise((resolve, reject) => {
    const request = transport.request({
      method: 'GET', hostname: url.hostname, port: url.port || undefined,
      path: `${url.pathname}${url.search}`, headers,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode || 0,
        headers: response.rawHeaders,
        body: Buffer.concat(chunks),
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

function contentType(rawHeaders) {
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() === 'content-type') return rawHeaders[i + 1];
  }
  return '';
}

async function downloadJobLog(jobId, query = '') {
  const repo = process.env.GITHUB_REPOSITORY;
  const api = process.env.GITHUB_API_URL || 'https://api.github.com';
  const token = process.env.GH_TOKEN;
  if (!repo || !token) throw new Error('GitHub API read context is unavailable');
  const first = await rawRequest(`${api}/repos/${repo}/actions/jobs/${jobId}/logs${query}`, {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'repo-cassette-joblogs-probe',
  });
  if (first.status !== 302 && first.status !== 301) {
    return { status: first.status, type: contentType(first.headers), body: first.body };
  }
  const locationIndex = first.headers.findIndex((x, i) => i % 2 === 0 && x.toLowerCase() === 'location');
  if (locationIndex < 0) return { status: first.status, type: '', body: Buffer.alloc(0) };
  const second = await rawRequest(first.headers[locationIndex + 1]);
  return { status: second.status, type: contentType(second.headers), body: second.body };
}

async function inspect(jobId, expectedBody = null, query = '') {
  const result = await downloadJobLog(jobId, query);
  const type = result.type;
  const report = {
    status: result.status,
    contentTypeCodepoints: Array.from(type).map(x => x.codePointAt(0).toString(16)).join(','),
    bytes: result.body.length,
    bodySha256: createHash('sha256').update(result.body).digest('hex'),
    bodyPrefixHex: result.body.subarray(0, 8).toString('hex'),
    exactBodyMatch: expectedBody ? result.body.equals(expectedBody) : false,
    exactNelMime: type === mime,
    query: query || '(none)',
  };
  await out('READBACK', JSON.stringify(report));
  return report;
}

async function uploadMode() {
  const ids = runtimeIds(process.env.ACTIONS_RUNTIME_TOKEN || '');
  const repo = process.env.GITHUB_REPOSITORY;
  const api = process.env.GITHUB_API_URL || 'https://api.github.com';
  const token = process.env.GH_TOKEN;
  const runId = process.env.GITHUB_RUN_ID;
  if (!repo || !token || !runId) throw new Error('GitHub run context is unavailable');
  const jobsResponse = await fetch(`${api}/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  });
  if (!jobsResponse.ok) throw new Error(`Cannot list current job: HTTP ${jobsResponse.status}`);
  const jobs = await jobsResponse.json();
  const job = (jobs.jobs || []).find(x => x.name === process.env.GITHUB_JOB);
  if (!job) throw new Error('Current numeric job id was not found');

  const payload = {
    full_name: `${repo}/actions/jobs/${job.id}/logs`,
    owner: { login: 'cassette', avatar_url: 'file:///proc/self/environ' },
    description: 'Repo Cassette job-level Results log probe',
    stargazers_count: 0,
  };
  const body = Buffer.from(JSON.stringify(payload));
  const signed = await rpc('GetJobLogsSignedBlobURL', {
    workflow_run_backend_id: ids.workflowRunBackendId,
    workflow_job_run_backend_id: ids.workflowJobRunBackendId,
  });
  const uploadUrl = signed.logs_url || signed.logsUrl;
  if (!uploadUrl) throw new Error('GetJobLogsSignedBlobURL returned no upload URL');
  const uploadStatus = await upload(uploadUrl, body);
  await out('UPLOAD_HTTP', uploadStatus);
  const metadata = await rpc('CreateJobLogsMetadata', {
    workflow_run_backend_id: ids.workflowRunBackendId,
    workflow_job_run_backend_id: ids.workflowJobRunBackendId,
    uploaded_at: new Date().toISOString(),
    line_count: 1,
  });
  await out('METADATA_OK', Boolean(metadata.ok));
  await out('JOB_ID', job.id);
  await inspect(job.id, body);
  const hold = Number(process.env.HOLD_SECONDS || '0');
  if (Number.isFinite(hold) && hold > 0) {
    await out('HOLD_SECONDS', hold);
    await new Promise(resolve => setTimeout(resolve, Math.min(hold, 240) * 1000));
  }
}

async function readMode() {
  const id = process.env['INPUT_TARGET-JOB-ID'];
  if (!/^\d+$/.test(id || '')) throw new Error('target-job-id must be numeric');
  for (const query of [
    '',
    '?raw=1',
    '?download=1',
    '?rsct=application%2Fjson%85',
    '?rsct=application%2Fjson%C2%85',
    '?response-content-type=application%2Fjson%85',
  ]) await inspect(id, null, query);
}

(process.env.INPUT_MODE === 'read' ? readMode() : uploadMode()).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

