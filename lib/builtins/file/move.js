// file-move action — copies/moves files or entire directories from one
// location to another. Source + target can each be local/sharepoint/google
// (i.e. it uses getSource(sourceType) on both ends).
//
// Streaming: always streamed when files are large. Input flag:
//   { operation: 'copy' | 'move', overwrite: boolean }
//
// Implementation pending user spec.
