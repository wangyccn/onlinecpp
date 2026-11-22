/** Canonical workspace-relative paths; never allow traversal outside its root. */
export function cleanNativePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) throw new Error('Path escapes the selected folder'); parts.pop(); }
    else if (part.includes('\0')) throw new Error('Invalid path');
    else parts.push(part);
  }
  return parts.join('/');
}

/** Decode Clang's Makefile escaping before looking up the exact input snapshot. */
export function localDependencies(depfile: string): string[] {
  const paths = depfile.replace(/\\\r?\n/g, ' ').match(/\/home\/user\/(?:\\.|[^\s])+/g) || [];
  const decoded = paths.map((raw) => cleanNativePath(raw.slice('/home/user/'.length).replace(/\\(.)/g, '$1').replace(/\$\$/g, '$')));
  return [...new Set(decoded)];
}
