/** Offset-preserving C++ comment/literal masking, shared by fallback analysis and providers. */
export function scanCpp(source: string) {
  const code = source.split(''), symbols = source.split('');
  const comments: Array<{ start: number; end: number; closed: boolean }> = [];
  const mask = (target: string[], start: number, end: number) => {
    for (let i = start; i < end; i++) if (source[i] !== '\n' && source[i] !== '\r') target[i] = ' ';
  };
  for (let i = 0; i < source.length;) {
    const start = i;
    if (source.startsWith('//', i)) {
      i += 2;
      while (i < source.length) {
        if (source[i] === '\n' && source[i - 1] !== '\\' && !(source[i - 1] === '\r' && source[i - 2] === '\\')) break;
        i++;
      }
      comments.push({ start, end: i, closed: false });
      mask(code, start, i); mask(symbols, start, i);
    } else if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2), closed = end !== -1;
      i = closed ? end + 2 : source.length; comments.push({ start, end: i, closed });
      mask(code, start, i); mask(symbols, start, i);
    } else {
      const raw = source[i] === 'R' ? /^R"([^\s()\\]{0,16})\(/.exec(source.slice(i)) : null;
      if (raw) {
        const delimiter = ')' + raw[1] + '"', end = source.indexOf(delimiter, i + raw[0].length);
        i = end === -1 ? source.length : end + delimiter.length; mask(symbols, start, i);
      } else if (source[i] === '"' || (source[i] === "'" && !/[\w]/.test(source[i - 1] || ''))) {
        const quote = source[i++];
        while (i < source.length) {
          if (source[i] === '\\') { i = Math.min(source.length, i + 2); continue; }
          if (source[i++] === quote) break;
          if (source[i - 1] === '\n') break;
        }
        mask(symbols, start, i);
      } else i++;
    }
  }
  return { code: code.join(''), symbols: symbols.join(''), comments };
}

export function isCppComment(scan: ReturnType<typeof scanCpp>, offset: number): boolean {
  return scan.comments.some(({ start, end, closed }) => offset >= start + 2 && (offset < end || (!closed && offset === end)));
}
