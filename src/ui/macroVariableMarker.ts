/**
 * §9.6 marker for a macro that will actually prompt for input, shared by the
 * sidebar (macroTreeProvider.ts) and the quick-pick (macroCommands.ts) so the
 * two can never drift.
 *
 * ASCII-safe by design: U+2338 (⌸) renders as tofu in common Windows system
 * fonts, and Windows desktop users are this extension's primary audience.
 *
 * Deliberately its own zero-dependency module rather than living in
 * macroTreeProvider.ts: that file's `class MacroTreeItem extends
 * vscode.TreeItem` executes at module-load time, so a plain VALUE import of
 * anything from it (unlike a type-only import, which TypeScript erases)
 * forces every importer to also load `vscode` fully shaped — several unit
 * tests mock `vscode` narrowly enough that this throws at import time.
 */
export const VARIABLE_MARKER = "[?] ";
