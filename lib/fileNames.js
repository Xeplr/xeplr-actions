// WHAT A SAVED FILE IS CALLED, AND WHAT HAPPENS WHEN ONE IS ALREADY THERE.
//
// One rule for every action that writes a file, so a workflow can say
// "Bank-2026-09.csv" instead of getting "3f9a1c02e4_statement.csv".
//
// A name is a template with two kinds of placeholder:
//   {…}  from the WORKFLOW, filled in by the engine before the step runs:
//        Bank-{trigger.window.from|date:YYYY-MM}
//   […]  from the FILE ITSELF, filled in here: [original] [name] [ext] [n]
//        and whatever the action adds (an email's [subject], [id]).
// Square brackets because the engine fills every {…} first, and would blank
// a file's own placeholders before the action ever saw them.
//
// ifExists, when the name is already taken:
//   fail       (default) the step fails, naming the file: nothing is written,
//              so a second run for the same period is caught, not repeated
//   skip       nothing is written for it, and it is listed in `existing`, so
//              the next step can branch on "already downloaded"
//   overwrite  replaced
//   addSuffix  "Bank-2026-09 (2).csv"
// Decided for the whole step before anything is written, so `fail` never
// leaves half a batch behind.

var fs = require('fs');
var path = require('path');

var IF_EXISTS = ['fail', 'skip', 'overwrite', 'addSuffix'];

function nameError(message, code) {
  var err = new Error(message);
  err.code = code || 'FILE_NAME_INVALID';
  err.status = 400;
  return err;
}

/**
 * A name that is safe to join to a directory: no separators, no characters
 * a filesystem refuses, not "." or "..". Spaces are kept — "Bank Sep 2026.csv"
 * is a name a person wants.
 */
function safeName(name) {
  var out = String(name == null ? '' : name)
    .replace(/[\/\\:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  if (!out || /^\.+$/.test(out)) return '';
  return out;
}

/** The parts of an original file name: [original], [name], [ext]. */
function partsOf(original) {
  var o = safeName(original) || 'file';
  var dot = o.lastIndexOf('.');
  var hasExt = dot > 0 && dot < o.length - 1;
  return { original: o, name: hasExt ? o.slice(0, dot) : o, ext: hasExt ? o.slice(dot + 1) : '' };
}

/**
 * The name from `template` and the file's own `tokens`. A placeholder the
 * file does not have is refused, listing the ones it does — a typo must not
 * quietly drop part of a name.
 */
function nameFrom(template, tokens) {
  var unknown = [];
  var out = String(template).replace(/\[([A-Za-z]+)\]/g, function(whole, key) {
    if (!Object.prototype.hasOwnProperty.call(tokens, key)) { unknown.push(key); return whole; }
    var v = tokens[key];
    return v === null || v === undefined ? '' : String(v);
  });
  if (unknown.length) {
    throw nameError('The file name "' + template + '" uses [' + unknown.join('], [') + '], which this file does not have. ' +
      'It has: [' + Object.keys(tokens).join('], [') + '].');
  }
  var safe = safeName(out);
  if (!safe) throw nameError('The file name "' + template + '" comes out empty. Check the values it is made from.');
  return safe;
}

function withSuffix(name, k) {
  var dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) + ' (' + k + ')' + name.slice(dot) : name + ' (' + k + ')';
}

/**
 * Where each file goes, decided for the whole step before anything is
 * written. `names` in order; returns [{ name, path, write }] where `write`
 * is false for one skipped. Throws FILE_EXISTS for `fail`.
 */
function plan(dir, names, ifExists) {
  var mode = ifExists || 'fail';
  if (IF_EXISTS.indexOf(mode) === -1) {
    throw nameError('ifExists is one of ' + IF_EXISTS.join(', ') + ', not "' + mode + '".');
  }
  var taken = {};
  var exists = function(n) { return taken[n] || fs.existsSync(path.join(dir, n)); };
  return names.map(function(name) {
    var out = name;
    if (exists(out)) {
      if (mode === 'fail') {
        throw nameError('"' + out + '" is already in ' + dir + '. Nothing was saved. ' +
          'Set ifExists to skip, overwrite or addSuffix to save anyway.', 'FILE_EXISTS');
      }
      if (mode === 'skip') return { name: out, path: path.join(dir, out), write: false };
      if (mode === 'addSuffix') {
        var k = 2;
        while (exists(withSuffix(name, k))) k++;
        out = withSuffix(name, k);
      }
      // overwrite: the same name, written again. Two files of THIS step with
      // one name still get a suffix: overwriting its own first file would lose it.
      if (mode === 'overwrite' && taken[out]) {
        var j = 2;
        while (taken[withSuffix(name, j)]) j++;
        out = withSuffix(name, j);
      }
    }
    taken[out] = true;
    return { name: out, path: path.join(dir, out), write: true };
  });
}

/** The inputs every file-writing action takes, to spread into its inputSchema. */
function nameInputs(order, tokensHelp) {
  return [
    { name: 'fileName', type: 'string', order: order, group: 'Saving',
      description: 'What to call the file. {…} comes from the workflow, e.g. Bank-{trigger.window.from|date:YYYY-MM}; ' +
        '[…] from the file: ' + tokensHelp + '. Empty: a random prefix and the original name.' },
    { name: 'ifExists', type: 'string', order: order + 1, group: 'Saving', default: 'fail',
      options: IF_EXISTS,
      description: 'When the name is taken. fail: the step fails and nothing is saved. skip: listed in `existing`, not saved. ' +
        'overwrite: replaced. addSuffix: "name (2).ext". Only with a file name.' }
  ];
}

module.exports = { safeName: safeName, partsOf: partsOf, nameFrom: nameFrom, plan: plan, nameInputs: nameInputs, IF_EXISTS: IF_EXISTS };
