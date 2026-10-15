export type CursorOriginalInput = {
  readonly executable: string;
  readonly home: string;
  readonly version: string;
  readonly urlPrefix: string;
};
export function parseCursorOriginalVersion(output: string): string;
export function prepareCursorOriginalUpdate(input: CursorOriginalInput): {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>> & {
    readonly HOME: string;
    readonly TMPDIR: string;
    readonly PATH: string;
    readonly AGENT_CLI_CREDENTIAL_STORE: string;
  };
  readonly installDirectory: string;
  readonly aliases: readonly string[];
  readonly cursorShim: string;
  readonly writeRoots: readonly string[];
  readonly detachedCleanup: { readonly command: string; readonly args: readonly string[] };
};
