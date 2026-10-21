export type FontFamilyTarget = 'ui' | 'terminal';

export function firstFontFamily(value: string): string {
  let result = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const character of value) {
    if (escaped) {
      result += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        result += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ',') {
      break;
    }
    result += character;
  }

  return result.trim();
}

export function quoteFontFamily(name: string): string {
  return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function fontFamilyStack(name: string, target: FontFamilyTarget): string {
  const primary = quoteFontFamily(name);
  if (target === 'terminal') {
    return `${primary}, monospace`;
  }
  return `${primary}, "Microsoft YaHei", "PingFang SC", sans-serif`;
}
