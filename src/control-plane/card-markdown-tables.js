// Feishu card Markdown is not a full document renderer. Expand confirmed GFM
// tables before pagination so narrow cards never depend on horizontal columns.
function cellsOf(line) {
  const source = line.trim();
  const cells = [];
  let cell = '', ticks = 0, separators = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '\\' && i + 1 < source.length) {
      cell += char + source[++i];
    } else if (char === '`') {
      let run = 1;
      while (source[i + run] === '`') run++;
      if (!ticks) ticks = run;
      else if (ticks === run) ticks = 0;
      cell += '`'.repeat(run); i += run - 1;
    } else if (char === '|' && !ticks) {
      cells.push(cell.trim()); cell = ''; separators++;
    } else cell += char;
  }
  cells.push(cell.trim());
  if (!separators) return null;
  if (source.startsWith('|')) cells.shift();
  if (cells.at(-1) === '' && source.endsWith('|')) cells.pop();
  return cells;
}

export function cardMarkdownTables(text) {
  const lines = text.split('\n'), output = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const marker = lines[i].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      output.push(lines[i]);
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker) {
      fence = { char: marker[1][0], length: marker[1].length };
      output.push(lines[i]); continue;
    }
    const headers = cellsOf(lines[i]);
    const separator = i + 1 < lines.length ? cellsOf(lines[i + 1]) : null;
    if (!headers || headers.length < 2 || separator?.length !== headers.length
      || !separator.every((cell) => /^:?-{3,}:?$/.test(cell))) {
      output.push(lines[i]); continue;
    }
    const rows = [];
    let end = i + 2, invalid = false;
    for (; end < lines.length; end++) {
      const cells = cellsOf(lines[end]);
      if (!cells || /^ {0,3}(`{3,}|~{3,})/.test(lines[end])) break;
      if (cells.length > headers.length) { invalid = true; break; }
      rows.push(cells);
    }
    // Uncertain input is evidence too; never guess away an extra column.
    if (!rows.length || invalid) { output.push(lines[i]); continue; }
    output.push('');
    rows.forEach((row, index) => {
      output.push(`**记录 ${index + 1}**`);
      headers.forEach((header, column) => {
        const label = header.replace(/^\*\*(.*?)\*\*$/, '$1') || `字段 ${column + 1}`;
        output.push(`**${label}**：${row[column] || '—'}`);
      });
      output.push('');
    });
    i = end - 1;
  }
  return output.join('\n');
}
