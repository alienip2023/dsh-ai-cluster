// Edit the plain id/name form used by bundle patches without serializing YAML.
export function rewriteBundlePatch(text, targetName) {
  const lines = text.split(/(?<=\n)/)
  const candidates = []
  let insert = null
  for (const [index, line] of lines.entries()) {
    if (/^[ \t]*(?:#|\r?$)/.test(line)) continue
    const indent = line.match(/^ */)[0].length
    if (insert && indent <= insert.indent) insert = null
    const start = line.match(/^( *)- insert:[ \t]*(?:#[^\r\n]*)?\r?\n?$/)
    if (start) {
      insert = { indent: start[1].length + 2, itemIndent: null }
      continue
    }
    if (!insert) continue
    if (/^ *- /.test(line) && insert.itemIndent === null) insert.itemIndent = indent
    if (indent !== insert.itemIndent || !/^ *- id: remote-agent[ \t]*(?:#[^\r\n]*)?\r?\n?$/.test(line)) continue
    const name = lines[index + 1]?.match(/^( *name:[ \t]+)([^\s#]+)([ \t]*(?:#[^\r\n]*)?\r?\n?)$/)
    candidates.push({ index: index + 1, name: name && name[1].startsWith(' '.repeat(indent + 2) + 'name:') ? name : null })
  }
  if (candidates.length !== 1 || !candidates[0].name) {
    throw new Error(`Expected exactly one insert entry with id: remote-agent and an adjacent name; found ${candidates.length} id entries and ${candidates.filter(candidate => candidate.name).length} id/name pairs`)
  }
  const { index, name } = candidates[0]
  if (name[2] === targetName) return text
  lines[index] = name[1] + targetName + name[3]
  return lines.join('')
}
