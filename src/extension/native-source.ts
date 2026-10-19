/** Native PCB source is multiple DOCTYPE sections, including embedded footprints.
 * EasyEDA moves edited component records to the end on restore. Only these
 * records are order-independent here; unknown records retain strict ordering.
 */
export function equivalentNativeSource(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  function sections(source: string): string | undefined {
    const result: Array<{ordered: string[]; components: string[]}> = [];
    let normalize = false;
    let keys = new Set<string>();
    let section: {ordered: string[]; components: string[]} | undefined;
    for (const line of source.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let record: unknown;
      try { record = JSON.parse(line); } catch { return undefined; }
      if (!Array.isArray(record) || typeof record[0] !== 'string') return undefined;
      if (record[0] === 'DOCTYPE') {
        section = {ordered: [], components: []};
        result.push(section);
        normalize = ['PCB', 'FOOTPRINT'].includes(record[1]) && record[2] === '1.8';
        keys = new Set();
      }
      if (!section) return undefined;
      // Keep complete record bytes; do not round geometry or discard fields.
      if (normalize && ['COMPONENT', 'ATTR', 'PAD_NET'].includes(record[0])) {
        const key = record[0] === 'ATTR' ? JSON.stringify(['ATTR', record[3], record[7]])
          : record[0] === 'PAD_NET' ? JSON.stringify(['PAD_NET', record[1], record[4]])
          : JSON.stringify(['COMPONENT', record[1]]);
        if (keys.has(key)) return undefined;
        keys.add(key);
        section.components.push(line);
      } else section.ordered.push(line);
    }
    if (!result.length) return undefined;
    for (const section of result) section.components.sort();
    return JSON.stringify(result);
  }
  const normalized = sections(expected);
  return normalized !== undefined && normalized === sections(actual);
}
