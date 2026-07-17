// Local filesystem source — implementation pending user spec.
// No peer deps (uses Node's fs).
//
// Interface every file source implements (uniform across local/sharepoint/google):
//
//   requires:            []                                       // peer deps
//
//   async readFile(config, { path, streaming_mode? })
//        streaming_mode=false: { content: Buffer|string, bytes }
//        streaming_mode=true:  { filePath: <local temp path>, format:'raw', bytes }
//
//   async writeFile(config, { path, content?, filePath?, streaming_mode? })
//        writes raw bytes; when streaming_mode=true and filePath is set,
//        streams from that file
//
//   async listFiles(config, { path, pattern? })
//                                          → [{ name, size, mtime }]
//
//   async moveFile(config, { from, to })   → void
//   async deleteFile(config, { path })     → void

module.exports = {
  requires: []
};
