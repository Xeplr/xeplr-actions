// s3-upload action — one file from this company's data folder to an S3 bucket
// (or an S3-compatible store: `endpoint`).
//
// Streamed in parts (@aws-sdk/lib-storage Upload), so a file of any size
// needs no more memory than a few parts. Every part carries a SHA-256
// checksum: a bucket with Object Lock refuses a PUT without one, and S3
// checks the bytes it got against it.
//
// IT ONLY WRITES. No list, read or head of the bucket — a backup key should be
// allowed s3:PutObject (and s3:AbortMultipartUpload, so a failed upload is
// cleaned up) and nothing else, so a leaked key can add files and do no more.
//
// Peer deps, optional and lazy-required: @aws-sdk/client-s3 and
// @aws-sdk/lib-storage.
//
// The connection: { bucket, region, accessKeyId, secretAccessKey, prefix?,
// sessionToken?, endpoint?, forcePathStyle? } — a saved connection
// (connectionInfoId) the host resolves; never typed into a step.

var fs = require('fs');
var path = require('path');
var dataDir = require('../../dataDir');

var PART_SIZE = 16 * 1024 * 1024;
var QUEUE = 4;

function refuse(message, code) {
  var err = new Error(message);
  err.code = code;
  return err;
}

function aws() {
  try {
    return { s3: require('@aws-sdk/client-s3'), storage: require('@aws-sdk/lib-storage') };
  } catch (_) {
    throw refuse("s3-upload: '@aws-sdk/client-s3' and '@aws-sdk/lib-storage' are not installed. Run: npm install @aws-sdk/client-s3 @aws-sdk/lib-storage", 'MISSING_DEPENDENCY');
  }
}

/** The object's key: `key` as given, else <prefix>/<file name>; never starting with "/". */
function keyFor(input, conn, filePath) {
  if (input.key) return String(input.key).replace(/^\/+/, '');
  var prefix = String(conn.prefix || '').replace(/^\/+|\/+$/g, '');
  return (prefix ? prefix + '/' : '') + path.basename(filePath);
}

module.exports = {
  name: 's3-upload',
  // It writes, so it is never previewed.
  example: { bucket: 'acme-backups', key: 'backups/shop/shop-2026-11-13T02-00-05.dump', bytes: 104857600, etag: '"5d41402abc4b2a76b9719d911017c592-7"', versionId: '3HL4kqtJlcpXroDTDmJ.rmSpXd3dIbrHY', deleted: true },
  description: 'Upload one file from this company\'s data folder to an S3 bucket, in parts, with a SHA-256 checksum. Only writes: the key needs s3:PutObject (and s3:AbortMultipartUpload), nothing else. Returns { bucket, key, bytes, etag, versionId, deleted }.',
  requires: [],   // @aws-sdk/client-s3 and @aws-sdk/lib-storage checked at runtime

  inputSchema: [
    { name: 'connection', type: 'object', required: true, order: 1,
      description: '{ bucket, region, accessKeyId, secretAccessKey, prefix? } — a saved connection (connectionInfoId), resolved by the host.' },
    { name: 'filePath', type: 'string', required: true, order: 2,
      description: 'The file, in this company\'s data folder, e.g. {steps.dump.filePath}.' },
    { name: 'key', type: 'string', order: 3,
      description: 'The object\'s key in the bucket. Default: <prefix>/<file name>.' },
    { name: 'deleteAfter', type: 'boolean', default: false, order: 4,
      description: 'Delete the local file once it is uploaded.' },
    { name: 'contentType', type: 'string', order: 5, group: 'Upload options',
      description: 'Default: application/octet-stream.' }
  ],
  outputSchema: [
    { name: 'bucket', type: 'string' }, { name: 'key', type: 'string' }, { name: 'bytes', type: 'number' },
    { name: 'etag', type: 'string' }, { name: 'versionId', type: 'string' }, { name: 'deleted', type: 'boolean' }
  ],

  execute: async function(ctx) {
    var input = ctx.input || {};
    var system = ctx.system || {};
    var conn = input.connection || {};
    if (!conn.bucket) throw refuse('s3-upload: the connection names no bucket.', 'NO_BUCKET');
    if (!conn.region && !conn.endpoint) throw refuse('s3-upload: the connection names no region.', 'NO_REGION');
    var file = dataDir.resolve(input.filePath, 'The file to upload');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw refuse('s3-upload: "' + input.filePath + '" is not a file that exists.', 'FILE_NOT_FOUND');
    var bytes = fs.statSync(file).size;
    var key = keyFor(input, conn, file);

    var lib = aws();
    var clientConfig = { region: conn.region || 'us-east-1' };
    if (conn.accessKeyId) {
      clientConfig.credentials = { accessKeyId: String(conn.accessKeyId), secretAccessKey: String(conn.secretAccessKey || '') };
      if (conn.sessionToken) clientConfig.credentials.sessionToken = String(conn.sessionToken);
    }
    if (conn.endpoint) clientConfig.endpoint = String(conn.endpoint);
    if (conn.forcePathStyle) clientConfig.forcePathStyle = true;
    var client = new lib.s3.S3Client(clientConfig);

    var upload = new lib.storage.Upload({
      client: client,
      partSize: PART_SIZE,
      queueSize: QUEUE,
      leavePartsOnError: false,     // a failed upload is aborted (s3:AbortMultipartUpload)
      params: {
        Bucket: String(conn.bucket),
        Key: key,
        Body: fs.createReadStream(file),
        ContentLength: bytes,
        ContentType: input.contentType || 'application/octet-stream',
        ChecksumAlgorithm: 'SHA256'
      }
    });
    if (system.onProgress) upload.on('httpUploadProgress', function(p) { system.onProgress({ bytes: p.loaded || 0 }); });
    var onAbort = function() { upload.abort().catch(function() {}); };
    if (system.signal) {
      if (system.signal.aborted) onAbort();
      else system.signal.addEventListener('abort', onAbort, { once: true });
    }

    var res;
    try {
      res = await upload.done();
    } finally {
      if (system.signal) system.signal.removeEventListener('abort', onAbort);
      if (client.destroy) client.destroy();
    }
    var deleted = false;
    if (input.deleteAfter === true) {
      fs.unlinkSync(file);
      deleted = true;
    }
    return { bucket: String(conn.bucket), key: key, bytes: bytes, etag: (res && res.ETag) || null, versionId: (res && res.VersionId) || null, deleted: deleted };
  },

  // For tests.
  _keyFor: keyFor
};
