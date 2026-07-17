// file-upload action — reads file(s) from a source (local/sharepoint/google),
// optionally parses per format (excel/csv/txt/json), returns rows/content.
// Directory uploads = same action with multiple files (input.paths = [...]).
//
// Streaming: input.streaming_mode=true → source reads and format parsers
// operate on temp files instead of memory. Output shape:
//   streaming_mode=false: { rows: [...], files: [{name, bytes}] }
//   streaming_mode=true:  { filePath, format, bytes, files: [{name, bytes, filePath}] }
//
// The parsed intermediate lives as JSONL when streaming from a structured
// format (excel/csv), raw when the format is txt/json.
//
// Implementation pending user spec.
