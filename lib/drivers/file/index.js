// File source factory. Each action calls getSource(type) to get the right
// source driver, then invokes the common source interface (see local.js
// for the contract).
//
// Adding a new source type = add a file here + register it below.

var SOURCES = {
  local:      function() { return require('./local'); },
  sharepoint: function() { return require('./sharepoint'); },
  google:     function() { return require('./google'); },
  sftp:       function() { return require('./sftp'); }
};

function getSource(type) {
  var loader = SOURCES[type];
  if (!loader) {
    throw new Error('Unknown sourceType: "' + type + '". Supported: ' + Object.keys(SOURCES).join(', '));
  }
  return loader();
}

// Check a source's peer deps and throw a friendly error if any are missing.
// Called at action execution time (not registration) — the concrete
// sourceType is only known when the action fires.
function checkSourceRequires(actionName, sourceType, source) {
  var requires = (source && source.requires) || [];
  for (var i = 0; i < requires.length; i++) {
    try { require.resolve(requires[i]); }
    catch (_) {
      throw new Error(
        actionName + ' requires "' + requires[i] + '" for sourceType="' + sourceType + '". ' +
        'Install with: npm install ' + requires[i]
      );
    }
  }
}

module.exports = {
  getSource: getSource,
  checkSourceRequires: checkSourceRequires,
  SUPPORTED: Object.keys(SOURCES)
};
