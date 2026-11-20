import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const coreDir = fileURLToPath(new URL('../src/core', import.meta.url));
const extensionDir = fileURLToPath(new URL('../src/extension', import.meta.url));

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

describe('architectural layer isolation (DEC-003)', () => {
  it('src/core (recursive) contains zero imports from src/extension, src/ui, or chrome.* globals', () => {
    const files = walkTsFiles(coreDir);
    expect(files.length).toBeGreaterThanOrEqual(5);

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      expect(content, `${file} must not reference chrome.*`).not.toMatch(/\bchrome\./);
      expect(content, `${file} must not import src/extension`).not.toMatch(/['"][^'"]*extension\//);
      expect(content, `${file} must not import src/ui`).not.toMatch(/['"][^'"]*ui\//);
    }
  });

  it('src/extension (recursive) never imports from src/ui [ARCH-006 / QA-011]', () => {
    const files = walkTsFiles(extensionDir);
    expect(files.length).toBeGreaterThanOrEqual(3);

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      expect(content, `${file} must not import src/ui`).not.toMatch(/['"][^'"]*ui\//);
    }
  });
});
