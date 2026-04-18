const CAD_FONT_RULES = [
  {
    pattern: /(SIMPLEX|STANDARD|ROMANS|TXT|ARIAL|SWISS|GOTHIC|SANS)/i,
    bundledName: 'Source Sans 3',
    cssFamily: '"Source Sans 3", "Segoe UI", "Trebuchet MS", sans-serif',
  },
  {
    pattern: /(ISO|MONO|COURIER|CONSOLAS|TYPEWRITER|FIXED)/i,
    bundledName: 'Inconsolata',
    cssFamily: '"Inconsolata", "Consolas", "Courier New", monospace',
  },
  {
    pattern: /(ROMAN|SERIF|TIMES|SCRIPT|HAND|CALLIGRAPH)/i,
    bundledName: 'Merriweather',
    cssFamily: '"Merriweather", "Times New Roman", serif',
  },
];

const DEFAULT_WEB_FONT = {
  bundledName: 'Source Sans 3',
  cssFamily: '"Source Sans 3", "Segoe UI", "Trebuchet MS", sans-serif',
};

export function resolveCadWebFont({ styleName = '', fontFamily = '' } = {}) {
  const style = String(styleName || '').trim();
  const font = String(fontFamily || '').trim();
  const token = `${style} ${font}`.trim();

  const match = CAD_FONT_RULES.find((rule) => rule.pattern.test(token));
  if (match) {
    return {
      bundledName: match.bundledName,
      cssFamily: match.cssFamily,
      matchedBy: token || '(empty)',
    };
  }

  return {
    ...DEFAULT_WEB_FONT,
    matchedBy: token || '(default)',
  };
}
