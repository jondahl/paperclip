#!/usr/bin/env node
/**
 * Standalone `create-paperclip-plugin` CLI entry.
 *
 * This file is the package `bin`. It is intentionally separate from
 * `index.ts` (the library export consumed by the `paperclipai` CLI) so the
 * scaffolder's `runCli()` side-effect is never bundled into another
 * entrypoint. Previously the entry guard lived in `index.ts` and misfired
 * when esbuild bundled `index.ts` into `cli/dist/index.js`, causing every
 * `paperclipai` invocation to scaffold a plugin (PLA-154).
 */
import path from "node:path";
import {
  packageToDirName,
  scaffoldPluginProject,
  type PluginTemplate,
  type ScaffoldPluginOptions,
} from "./index.js";

function parseArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

/** CLI wrapper for `scaffoldPluginProject`. */
function runCli() {
  const pluginName = process.argv[2];
  if (!pluginName) {
    // eslint-disable-next-line no-console
    console.error("Usage: create-paperclip-plugin <name> [--template default|connector|workspace] [--output <dir>] [--sdk-path <paperclip-sdk-path>]");
    process.exit(1);
  }

  const template = (parseArg("--template") ?? "default") as PluginTemplate;
  const outputRoot = parseArg("--output") ?? process.cwd();
  const targetDir = path.resolve(outputRoot, packageToDirName(pluginName));

  const out = scaffoldPluginProject({
    pluginName,
    outputDir: targetDir,
    template,
    displayName: parseArg("--display-name"),
    description: parseArg("--description"),
    author: parseArg("--author"),
    category: parseArg("--category") as ScaffoldPluginOptions["category"] | undefined,
    sdkPath: parseArg("--sdk-path"),
  });

  // eslint-disable-next-line no-console
  console.log(`Created plugin scaffold at ${out}`);
}

runCli();
