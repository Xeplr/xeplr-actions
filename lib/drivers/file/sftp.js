// SFTP source — implementation pending user spec.
// Peer dep candidate: ssh2-sftp-client (friendlier wrapper) or ssh2 (raw).
// Implements the same interface as file/sources/local.js — see that file
// for the full contract including streaming_mode semantics.
// Config supplies host, port, username, and one of password | privateKey.

module.exports = {
  requires: ['ssh2-sftp-client']
};
