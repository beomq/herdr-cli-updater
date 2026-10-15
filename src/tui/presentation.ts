/** Trusted terminal tokens. Public text is sanitized before any token is added. */
export const ink = {
  normal: "\x1b[0m", title: "\x1b[1;36m", muted: "\x1b[38;5;245m", hint: "\x1b[38;5;250m",
  focus: "\x1b[1;7m", success: "\x1b[32m", warning: "\x1b[33m", error: "\x1b[31m",
} as const;
export const space = { gap: 1, padding: 1, border: 1, reservedColumn: 1, chromeRows: 5 } as const;

export function safe(text: string): string {
  return text
    .replace(/(?:\x1b\]|\u009d)[\s\S]*?(?:\x07|\x1b\\|\u009c|$)/g, "")
    .replace(/(?:\x1b[P^_X]|\u0090)[\s\S]*?(?:\x1b\\|\u009c|$)/g, "")
    .replace(/(?:\x1b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[ -/]*[@-~]/g, "")
    .replace(/[\p{Cc}\p{Cf}]/gu, "");
}

export function fit(text: string, columns: number): string {
  const width = Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 0;
  const clean = safe(text);
  if (Bun.stringWidth(clean) <= width) return clean;
  const suffix = ".".repeat(Math.min(3, width));
  const budget = width - suffix.length;
  let clipped = "";
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(clean)) {
    if (Bun.stringWidth(clipped + segment) > budget) break;
    clipped += segment;
  }
  return clipped + suffix;
}

export function catalogColumns(width: number): readonly number[] {
  const counts = 7;
  const available = Math.max(0, width - 3 * counts - 5 * space.gap);
  const cli = Math.max(0, Math.floor(available * .4));
  const installed = Math.max(0, Math.floor((available - cli) / 2));
  return [cli, installed, available - cli - installed, counts, counts, counts];
}

export function tableRow(values: readonly string[], widths: readonly number[]): string {
  return values.map((value, index) => {
    const width = widths[index] ?? 0;
    const text = fit(value, width);
    return text + " ".repeat(Math.max(0, width - Bun.stringWidth(text)));
  }).join(" ".repeat(space.gap));
}

function tone(line: string, index: number): string {
  if (line.startsWith(">")) return ink.focus;
  if (index === 0 || /^(CLI CATALOG|JOBS|CLI\s+Installed|.*\| (Choose update|Confirm effects))/.test(line))
    return ink.title;
  if (/\b(error:|failed|result: failed)\b/i.test(line)) return ink.error;
  if (/\b(unavailable|unsupported|unknown|unverified|not verified|waiting|pending|partial|recovery_required|Unavailable)\b/i.test(line))
    return ink.warning;
  if (/\b(result: completed|restart verified|Installation verified|Completion verified)\b/.test(line))
    return ink.success;
  if (/Enter|Up\/Down|PgUp|Cancel:|Host checks/.test(line)) return ink.hint;
  return ink.normal;
}

/** Fixed-cell panel; text is the control-free HostFrame projection, ansi is output-only. */
export function panel(lines: readonly string[], columns: number, rows: number, active: "catalog" | "jobs") {
  const width = Math.max(0, columns - space.reservedColumn);
  const inner = width - 2 * (space.padding + space.border);
  if (inner < 1 || rows < 4) {
    const text = lines.slice(0, rows).map(line => fit(line, width)).join("\n");
    return { text, ansi: ink.normal + text.replaceAll("\n", "\r\n") + ink.normal };
  }
  const edge = "+" + "-".repeat(width - 2 * space.border) + "+";
  const content = lines.slice(0, rows - 2 * space.border);
  while (content.length < rows - 2 * space.border) content.push("");
  const plain = [edge], colored = [ink.normal + ink.muted + edge + ink.normal];
  content.forEach((line, index) => {
    const clean = fit(line, inner);
    const padded = clean + " ".repeat(inner - Bun.stringWidth(clean));
    plain.push(`| ${padded} |`);
    let styled = tone(clean, index) + padded + ink.normal;
    if (index === 0) {
      const tab = active === "catalog" ? "[1 Catalog]" : "[2 Jobs]";
      styled = styled.replace(tab, ink.focus + tab + ink.normal + ink.title);
    }
    colored.push(ink.muted + "| " + ink.normal + styled + ink.muted + " |" + ink.normal);
  });
  plain.push(edge);
  colored.push(ink.muted + edge + ink.normal);
  return { text: plain.join("\n"), ansi: colored.join("\r\n") };
}
