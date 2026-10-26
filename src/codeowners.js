// Who owns a test file, from GitHub's CODEOWNERS: gitignore-style patterns, and the last
// matching line wins. https://docs.github.com/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners

function toRegExp(pattern) {
  // A slash at the start or in the middle ties the pattern to the repository root.
  const anchored = pattern.replace(/\/$/, '').includes('/');
  let p = pattern.replace(/^\//, '').replace(/\/$/, '');
  // `docs/*` owns files directly in docs/, not in its subdirectories.
  const directChildrenOnly = p.endsWith('/*');
  p = p
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\/\*\*$/, '\u0001')
    .replace(/\*\*/g, '\u0002')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '/.*')
    .replace(/\u0002/g, '.*');
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${p}${directChildrenOnly ? '' : '(?:/.*)?'}$`);
}

/** @returns {(path: string) => string[]} owners of a path, such as ["@qa-alice", "@org/web"] */
export function parseCodeowners(text) {
  const rules = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    rules.push({ re: toRegExp(pattern), owners });
  }
  return (path) => {
    const p = path.replace(/^\.?\//, '');
    for (let i = rules.length - 1; i >= 0; i--) {
      if (rules[i].re.test(p)) return rules[i].owners;
    }
    return [];
  };
}
