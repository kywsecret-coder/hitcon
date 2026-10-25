import { createHash } from 'node:crypto';
import { BlobClient } from '@azure/storage-blob';
import { internalArtifactTwirpClient } from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import { getBackendIdsFromToken } from '../node_modules/@actions/artifact/lib/internal/shared/util.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient();
const name = `cassette-no-mime-${process.env.GITHUB_RUN_ID}.json`;
const repository = process.env.GITHUB_REPOSITORY;
const oddType = '\u0085application/json';

// Version 7's protobuf schema marks mime_type optional. Omit it entirely,
// then observe whether the signed download URL follows the blob's own type.
const created = await client.CreateArtifact({
  workflowRunBackendId: ids.workflowRunBackendId,
  workflowJobRunBackendId: ids.workflowJobRunBackendId,
  name,
  version: 7,
});
if (!created.ok || !created.signedUploadUrl) throw new Error('CreateArtifact returned no upload URL');

const placeholderId = '0';
const body = Buffer.from(JSON.stringify({
  full_name: `${repository}/actions/artifacts/${placeholderId}/zip`,
  owner: { login: 'cassette', avatar_url: 'file:///proc/self/environ' },
  description: 'Repo Cassette omitted MIME carrier',
  stargazers_count: 0,
}));
const blob = new BlobClient(created.signedUploadUrl).getBlockBlobClient();
await blob.uploadData(body, { blobHTTPHeaders: { blobContentType: oddType } });

const digest = createHash('sha256').update(body).digest('hex');
const finalized = await client.FinalizeArtifact({
  workflowRunBackendId: ids.workflowRunBackendId,
  workflowJobRunBackendId: ids.workflowJobRunBackendId,
  name,
  size: String(body.length),
  hash: { value: `sha256:${digest}` },
});
if (!finalized.ok || !finalized.artifactId) throw new Error('FinalizeArtifact failed');

const artifactId = String(finalized.artifactId);
const finalBody = Buffer.from(JSON.stringify({
  full_name: `${repository}/actions/artifacts/${artifactId}/zip`,
  owner: { login: 'cassette', avatar_url: 'file:///proc/self/environ' },
  description: 'Repo Cassette omitted MIME carrier',
  stargazers_count: 0,
}));
// The body is self-referential, so overwrite the uploaded object after ID assignment.
await blob.uploadData(finalBody, { blobHTTPHeaders: { blobContentType: oddType } });

const signed = await client.GetSignedArtifactURL({
  workflowRunBackendId: ids.workflowRunBackendId,
  workflowJobRunBackendId: ids.workflowJobRunBackendId,
  name,
});
if (!signed.signedUrl) throw new Error('GetSignedArtifactURL returned no URL');
const signedUrl = new URL(signed.signedUrl);
const response = await fetch(signed.signedUrl);
const downloaded = Buffer.from(await response.arrayBuffer());
const contentType = response.headers.get('content-type') || '';
const rsct = signedUrl.searchParams.get('rsct');
console.log('NO_MIME_RESULT ' + JSON.stringify({
  artifactId,
  status: response.status,
  rsctHex: rsct === null ? null : Buffer.from(rsct).toString('hex'),
  contentTypeHex: Buffer.from(contentType, 'latin1').toString('hex'),
  byteLength: downloaded.length,
  bodyMatches: downloaded.equals(finalBody),
  bodySha256: createHash('sha256').update(downloaded).digest('hex'),
}));
