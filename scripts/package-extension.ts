#!/usr/bin/env bun

import { spawn } from 'bun';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

type ManifestV3 = {
  version: string;
  background?: { service_worker?: string };
  action?: { default_popup?: string; default_icon?: Record<string, string> };
  icons?: Record<string, string>;
  content_scripts?: Array<{ js?: string[] }>;
};

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function assertFile(relativePath: string, baseDir: string) {
  const abs = path.join(baseDir, relativePath);
  if (!(await pathExists(abs))) {
    throw new Error(`Missing required file: ${relativePath}`);
  }
}

async function validateExtensionLayout(extDir: string): Promise<{ version: string; filesToZip: string[] }> {
  const manifestPath = path.join(extDir, 'manifest.json');
  const raw = await fs.readFile(manifestPath, 'utf8');
  const manifest: ManifestV3 = JSON.parse(raw);

  if (!manifest?.version) throw new Error('manifest.json: missing version');

  // Background service worker
  const sw = manifest?.background?.service_worker || 'background.js';
  await assertFile(sw, extDir);

  // Popup
  const popup = manifest?.action?.default_popup || 'popup.html';
  await assertFile(popup, extDir);

  // Icons (ensure at least the ones referenced in manifest exist)
  const iconPaths = new Set<string>();
  const defaultIcon = manifest?.action?.default_icon || {};
  Object.values(defaultIcon).forEach((p) => p && iconPaths.add(p));
  const icons = manifest?.icons || {};
  Object.values(icons).forEach((p) => p && iconPaths.add(p));
  for (const rel of iconPaths) await assertFile(rel, extDir);

  // Content scripts
  const contentJs = (manifest?.content_scripts || []).flatMap((c) => c.js || []);
  for (const rel of contentJs) await assertFile(rel, extDir);

  // Minimal dynamic code check (best-effort)
  const scanTargets = ['background.js', 'contentScript.js', 'popup.js'];
  for (const rel of scanTargets) {
    const p = path.join(extDir, rel);
    if (!(await pathExists(p))) continue;
    const text = await fs.readFile(p, 'utf8');
    if (/\beval\s*\(|new\s+Function\s*\(/i.test(text)) {
      throw new Error(`Dynamic code usage found in ${rel} (eval/new Function).`);
    }
  }

  // Files/dirs to zip
  const filesToZip = [
    'manifest.json',
    'background.js',
    'contentScript.js',
    'popup.html',
    'popup.js',
    'icons',
    'vendor',
    'utils'
  ].filter(Boolean);

  // Verify presence of main entries
  for (const rel of filesToZip) {
    const abs = path.join(extDir, rel);
    if (!(await pathExists(abs))) {
      // Allow missing optional folders but ensure key files exist
      if (['icons', 'vendor', 'utils'].includes(rel)) continue;
      throw new Error(`Expected entry missing: ${rel}`);
    }
  }

  return { version: manifest.version, filesToZip };
}

async function runZip(extDir: string, outZipPath: string, entries: string[]) {
  // Remove preexisting archive to ensure a clean build
  try { await fs.rm(outZipPath); } catch {}
  const args = [
    '-r', // recurse
    '-9', // best compression
    outZipPath,
    ...entries,
    '-x', '**/.DS_Store', '**/*.map', '**/.git*', '**/node_modules/**', 'package*.json', 'README.md'
  ];
  const proc = spawn({ cmd: ['zip', ...args], cwd: extDir, stdout: 'inherit', stderr: 'inherit' });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`zip failed with code ${code}`);
}

async function main() {
  const repoRoot = process.cwd();
  const extDir = path.join(repoRoot, 'clients', 'web-extension');
  const downloadsDir = path.join(os.homedir(), 'Downloads');
  const distDir = path.join(repoRoot, 'dist');
  await fs.mkdir(distDir, { recursive: true });
  await fs.mkdir(downloadsDir, { recursive: true });

  const { version, filesToZip } = await validateExtensionLayout(extDir);
  const baseName = `notion-magic-clipper-${version}.zip`;
  const outZip = path.join(distDir, baseName);
  await runZip(extDir, outZip, filesToZip);

  const dest = path.join(downloadsDir, baseName);
  await fs.copyFile(outZip, dest);
  console.log('\nCreated ZIP:');
  console.log('  ' + outZip);
  console.log('Copied to:');
  console.log('  ' + dest);
}

main().catch((err) => {
  console.error('[package-extension] Error:', err?.message || err);
  process.exit(1);
});


