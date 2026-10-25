import { createHash } from 'node:crypto';
import { BlobClient } from '@azure/storage-blob';
import { internalArtifactTwirpClient } from './node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import { getBackendIdsFromToken } from './node_modules/@actions/artifact/lib/internal/shared/util.js';
import { StringValue } from './node_modules/@actions/artifact/lib/generated/index.js';

const weird = 'application/json\u0085';
const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient();
const name = 'mime-suffix-' + process.env.GITHUB_RUN_ID;
const repository = process.env.GITHUB_REPOSITORY;

function payload(artifactId) {
  return Buffer.from(JSON.stringify({
    full_name: repository + '/actions/artifacts/' + artifactId + '/zip',
    owner: { login: 'cassette', avatar_url: 'file:///proc/self/environ' },
    description: 'Repo Cassette trailing NEL MIME candidate',
    stargazers_count: 0,
  }));
}

async function main() {
  let created;
  try {
    created = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      version: 7,
      mimeType: StringValue.create({ value: weird }),
    });
  } catch (error) {
    console.log('CREATE_REJECTED=' + String(error).split(/\r?\n/)[0]);
    return;
  }

  const upload = async body => new BlobClient(created.signedUploadUrl)
    .getBlockBlobClient()
    .uploadData(body, { blobHTTPHeaders: { blobContentType: weird } });

  const placeholder = Buffer.from('{"probe":"placeholder"}');
  await upload(placeholder);
  const finalized = await client.FinalizeArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    size: String(placeholder.length),
    hash: StringValue.create({
      value: 'sha256:' + createHash('sha256').update(placeholder).digest('hex'),
    }),
  });
  const artifactId = String(finalized.artifactId);
  const body = payload(artifactId);
  await upload(body);

  const signed = await client.GetSignedArtifactURL({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
  });
  const signedUrl = signed.signedUrl;
  const response = await fetch(signedUrl);
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') || '';
  console.log('ARTIFACT_ID=' + artifactId);
  console.log('SIGNED_RSCT=' + JSON.stringify(new URL(signedUrl).searchParams.get('rsct')));
  console.log('DIRECT_STATUS=' + response.status);
  console.log('DIRECT_CONTENT_TYPE=' + JSON.stringify(contentType));
  console.log('DIRECT_CONTENT_TYPE_CODEPOINTS=' + Array.from(contentType, c => c.codePointAt(0).toString(16)).join(','));
  console.log('DIRECT_BYTES=' + bytes.length);
  console.log('DIRECT_SHA256=' + createHash('sha256').update(bytes).digest('hex'));
  console.log('DIRECT_PREFIX_HEX=' + bytes.subarray(0, 32).toString('hex'));
  console.log('BODY_MATCH=' + String(bytes.equals(body)));
}

main().catch(error => {
  console.log('PROBE_ERROR=' + String(error).split(/\r?\n/)[0]);
});
