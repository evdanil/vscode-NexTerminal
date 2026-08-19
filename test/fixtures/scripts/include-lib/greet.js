/*
 * A plain library file: NO @nexus-script marker, so it never shows up in the
 * Scripts view, the CodeLens or the picker — and can be included.
 */

// Module-relative nexus.fs: this must read include-lib/template.txt, even
// though a DIFFERENT template.txt sits next to the entry script that included
// this file.
exports.template = await nexus.fs.readText("./template.txt");

exports.hello = (who) => `hello ${who}`;

// A sibling include, written relative to THIS file's folder.
const inner = await nexus.include("./inner.js");
exports.innerValue = inner.value;
