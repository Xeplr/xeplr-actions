// db-push action — routes to getDriver(input.dbType), then invokes
// insert / upsert / truncate per input.mode.
//
// Streaming: input accepts EITHER
//   { rows: [...] }                    inline (default)
//   { filePath: '/tmp/...jsonl' }      stream from JSONL file
// When streaming_mode=true and filePath is set, the driver reads the
// file line-by-line and pushes in batches (batch size TBD in spec).
//
// Implementation pending user spec.
