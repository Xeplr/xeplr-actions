// File source + format factory. Same pattern as db/: sourceType routes
// to a source driver (local, sharepoint, google, ...) and format routes
// to a parser (excel, csv, txt, json).

var SOURCES = {
  local:      function() { return require('./sources/local'); },
  sharepoint: function() { return require('./sources/sharepoint'); },
  google:     function() { return require('./sources/google'); }
};

var FORMATS = {
  excel: function() { return require('./formats/excel'); },
  csv:   function() { return require('./formats/csv'); },
  txt:   function() { return require('./formats/txt'); },
  json:  function() { return require('./formats/json'); }
};

function getSource(type) {
  var loader = SOURCES[type];
  if (!loader) {
    throw new Error('Unknown sourceType: "' + type + '". Supported: ' + Object.keys(SOURCES).join(', '));
  }
  return loader();
}

function getFormat(type) {
  var loader = FORMATS[type];
  if (!loader) {
    throw new Error('Unknown format: "' + type + '". Supported: ' + Object.keys(FORMATS).join(', '));
  }
  return loader();
}

// Same friendly-error check as db/ — called at runtime once the concrete
// driver / format is known.
function checkRequires(actionName, kind, name, mod) {
  var requires = (mod && mod.requires) || [];
  for (var i = 0; i < requires.length; i++) {
    try { require.resolve(requires[i]); }
    catch (_) {
      throw new Error(
        actionName + ' requires "' + requires[i] + '" for ' + kind + '="' + name + '". ' +
        'Install with: npm install ' + requires[i]
      );
    }
  }
}

module.exports = {
  getSource: getSource,
  getFormat: getFormat,
  checkRequires: checkRequires,
  SUPPORTED_SOURCES: Object.keys(SOURCES),
  SUPPORTED_FORMATS: Object.keys(FORMATS)
};
