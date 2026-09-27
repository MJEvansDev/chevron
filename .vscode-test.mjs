import { defineConfig } from '@vscode/test-cli';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const multiRoot = path.join(here, '.vscode-test', 'multiroot');

const mocha = {
  ui: 'tdd',
  timeout: 60000,
};

// Both fixtures are built by test/setup/buildFixtureRepo.mjs. Run one with `vscode-test --label <label>`.
export default defineConfig([
  {
    label: 'single-repo',
    files: 'out/test/integration/**/*.test.js',
    workspaceFolder: path.join(here, '.vscode-test', 'fixture-repo'),
    mocha,
  },
  {
    label: 'multiroot',
    files: 'out/test/integration-multiroot/**/*.test.js',
    workspaceFolder: path.join(multiRoot, 'multiroot.code-workspace'),
    // Own user-data dir (wiped by the fixture builder), so no workspaceState — stored comparison
    // targets, active repo — survives from a previous run.
    launchArgs: [`--user-data-dir=${path.join(here, '.vscode-test', 'user-data-multiroot')}`],
    // The fixture lives inside this (git) checkout; stop git walking up out of the fixture so its
    // `not-a-repo` folder really isn't one.
    env: { GIT_CEILING_DIRECTORIES: multiRoot },
    mocha,
  },
]);
