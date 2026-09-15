// Normalize model-generated emphasis for narrow-card Markdown without touching code examples.
export function cardMarkdownEmphasis(text) {
  let fence = null;
  return text.split('\n').map((line) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return line;
    }
    if (fence) return line;
    // Paired inline-code spans are opaque, including double-backtick spans.
    return line.split(/((`+).*?\2)/g).filter((_, index) => index % 3 !== 2).map((part, index) => {
      if (index % 2) return part;
      return part.replace(/(?<![\\*])\*\*([^*\n]+?)(?<!\\)\*\*(?!\*)/g, (raw, body, offset, source) => {
        const content = body.trim();
        if (!content) return raw;
        // Avoid splitting a huge emphasis span across pagination boundaries.
        if (Array.from(content).length > 1000) return content;
        const before = offset > 0 && !/\s/.test(source[offset - 1]) ? ' ' : '';
        const after = offset + raw.length < source.length && /[\p{L}\p{N}]/u.test(source[offset + raw.length]) ? ' ' : '';
        return `${before}**${content}**${after}`;
      });
    }).join('');
  }).join('\n');
}
