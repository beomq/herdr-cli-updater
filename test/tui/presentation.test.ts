import { expect, test } from "bun:test";
import { catalogColumns, fit, ink, panel, safe, tableRow } from "../../src/tui/presentation";

test.each([[80, 24], [120, 40]])("frames trusted ANSI within %ix%i cells", (columns, rows) => {
  const width = columns - 5;
  const table = tableRow(["> 한글 CLI", "1.0", "2.0", "(2/3)", "inspect"], catalogColumns(width));
  const result = panel(["CLI UPDATER  [1 Catalog]  [2 Jobs]", table], columns, rows, "catalog");
  const lines = result.text.split("\n");
  expect(lines).toHaveLength(rows);
  expect(lines.every(line => Bun.stringWidth(line) === columns - 1)).toBe(true);
  expect(lines.slice(1, -1).every(line => line.startsWith("| ") && line.endsWith(" |"))).toBe(true);
  expect(result.ansi).toContain(ink.focus + "[1 Catalog]");
  expect(result.ansi).toContain(ink.focus + table);
  expect(Bun.stripANSI(result.ansi).replaceAll("\r\n", "\n")).toBe(result.text);
  expect(result.ansi.endsWith(ink.normal)).toBe(true);
});

test("strips untrusted controls before adding only design token sequences", () => {
  const hostile = "> 한글\x1b[35m\x1b]0;PRIVATE_TITLE\x07\u009d0;PRIVATE_C1\u009c"
    + "\x1bPPRIVATE_DCS\x1b\\\r\t\u202e\x1b[2J";
  const result = panel(["CLI UPDATER [1 Catalog] [2 Jobs]", hostile], 80, 24, "jobs");
  expect(result.ansi).toContain(ink.focus + "[2 Jobs]");
  expect(result.ansi).not.toContain("PRIVATE_");
  expect(result.ansi).not.toContain("\x1b[35m");
  expect(result.ansi).not.toContain("\x1b[2J");
  const controls = result.ansi.match(/\x1b\[[0-9;]*m/g) ?? [];
  expect(controls.every(control => Object.values(ink).some(token => token === control))).toBe(true);
  expect(safe(result.text).includes("한글")).toBe(true);
  expect(result.text.replaceAll("\n", "")).not.toMatch(/[\p{Cc}\p{Cf}]/u);
});

test.each([1, 2, 4, 6, 20, 80, 120])("clips whole graphemes and degrades small panels at %i columns", columns => {
  const value = "x".repeat(Math.max(0, columns - 4)) + "한👩‍💻" + "x".repeat(200);
  for (const rows of [0, 1, 2, 3, 4, 24]) {
    const result = panel([value, value, value], columns, rows, "catalog");
    expect(result.text === "" ? 0 : result.text.split("\n").length).toBeLessThanOrEqual(rows);
    expect(result.text.split("\n").every(line => Bun.stringWidth(line) < columns)).toBe(true);
    expect(Bun.stripANSI(result.ansi).replaceAll("\r\n", "\n")).toBe(result.text);
  }
  expect(Bun.stringWidth(fit(value, columns))).toBeLessThanOrEqual(columns);
});

test("column padding sanitizes each cell before it can affect its neighbors", () => {
  const widths = catalogColumns(75);
  const values = ["omo", "1.0\x1b]0;PRIVATE_TITLE\x07", "2.0", "2", "1", "0"];
  const row = tableRow(values, widths);
  let column = 0;
  values.forEach((value, index) => {
    const width = widths[index] ?? 0;
    expect(Bun.sliceAnsi(row, column, column + width).trim()).toBe(fit(value, width));
    column += width + 1;
  });
  expect(Bun.stringWidth(row)).toBe(75);
  expect(row).not.toContain("PRIVATE_TITLE");
});
