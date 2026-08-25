// Fixture for test/unit/esbuildWorkerIsolation.test.ts. Deliberately imports
// the `vscode` module so the out-of-host build configurations can be shown to
// REJECT it. Never imported by production code.
import * as vscode from "vscode";

export const importedKind = typeof vscode;
