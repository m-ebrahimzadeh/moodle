import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const coreDir = fileURLToPath(new URL('../src/core', import.meta.url));
const extensionDir = fileURLToPath(new URL('../src/extension', import.meta.url));
const uiDir = fileURLToPath(new URL('../src/ui', import.meta.url));

function walkTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

function extractModuleSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  const staticImportExport = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"`]([^'"`]+)['"`]/g;
  const dynamicImport = /\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  for (const regex of [staticImportExport, dynamicImport]) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      if (match[1]) {
        specifiers.push(match[1]);
      }
    }
  }
  return specifiers;
}

describe('architectural layer isolation (DEC-003)', () => {
  it('src/core (recursive) contains zero imports from src/extension, src/ui, or chrome globals', () => {
    const files = walkTsFiles(coreDir);
    expect(files.length).toBeGreaterThanOrEqual(5);

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      expect(content, `${file} must not reference chrome globals`).not.toMatch(
        /\bchrome(?:\s*\?\.|\s*\.|\s*\[)|\bglobalThis\.chrome\b|\btypeof\s+chrome\b/,
      );
      for (const spec of extractModuleSpecifiers(content)) {
        expect(spec, `${file} must not import src/extension (${spec})`).not.toMatch(
          /(?:^|\/)extension(?:\/|$)/,
        );
        expect(spec, `${file} must not import src/ui (${spec})`).not.toMatch(
          /(?:^|\/)ui(?:\/|$)/,
        );
      }
    }
  });

  it('src/extension (recursive) never imports from src/ui [ARCH-006 / QA-011]', () => {
    const files = walkTsFiles(extensionDir);
    expect(files.length).toBeGreaterThanOrEqual(3);

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const spec of extractModuleSpecifiers(content)) {
        expect(spec, `${file} must not import src/ui (${spec})`).not.toMatch(
          /(?:^|\/)ui(?:\/|$)/,
        );
      }
    }
  });

  it('src/ui (recursive) imports from src/extension only via messages contracts [ARCH-NOTE-002]', () => {
    const files = walkTsFiles(uiDir);
    expect(files.length).toBeGreaterThanOrEqual(1);

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const spec of extractModuleSpecifiers(content)) {
        if (/(?:^|\/)extension(?:\/|$)/.test(spec)) {
          expect(spec, `${file} may only import extension/messages (${spec})`).toMatch(
            /\/extension\/messages(?:\.js|\.ts)?$/,
          );
        }
      }
    }
  });
});
