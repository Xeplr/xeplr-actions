// db-fetch action — routes to getDriver(input.dbType), then invokes
// fetchTable / fetchQuery / callProcedure per input.mode.
//
// Streaming: when input.streaming_mode=true, the output blob contains
// { filePath, format:'jsonl', bytes, rows } instead of inline rows.
// The temp file lives under XEPLR_ACTIONS_TMP_DIR (default os.tmpdir()
// + '/xeplr-actions/'), named <occurrenceId>_db-fetch_<seq>.jsonl.
// Cleanup: none in-action — rely on the sweep-temp-files action.
//
// Implementation pending user spec.
