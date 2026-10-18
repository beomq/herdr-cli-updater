/** Independent install catalog; update/session capabilities remain with the original engine. */
import type { OfficialInstallPlan, OfficialMethod } from './catalog-official';
export const catalogIds = ['agy','amp','claude','cline','codex','cursor','devin','droid','gjc','copilot','grok','hermes','kilo','kimi','kiro','letta','maki','muse','omp','omo','opencode','pi','qodercli','qwen'] as const;
export type CatalogId = typeof catalogIds[number];
export const supportedCatalogIds = ['claude','codex','gjc','omp','omo','opencode','pi'] as const;
export function isSupportedCli(value: string | null | undefined): boolean {
  return supportedCatalogIds.some(id => id === value);
}
export type CatalogCheck = {
  readonly status:'checking'|'available'|'current'|'ahead'|'unknown'|'unsupported'|'failed';
  readonly latestVersion:string|null;
  readonly checkedAt:number;
  readonly failure:string|null;
};
export type CatalogInstallation = {
  readonly id:string;
  readonly catalogId:CatalogId;
  readonly manager:'owned'|'bun'|'npm'|'brew'|'unknown';
  readonly root:string;
  readonly packageName:string|null;
  readonly path:string;
  readonly identityPath:string;
  readonly isDefault:boolean;
  readonly receiptId:string|null;
  readonly version:string|null;
  readonly versionStatus?:'checking'|'known'|'unsupported'|'timeout'|'failed'|'unrecognized';
  readonly checkedAt?:number|null;
  readonly removalSupport?:{readonly kind:'review'|'unsupported';readonly reason:string|null};
};
export type CatalogEntry = {
  readonly id: CatalogId;
  readonly name: string;
  readonly description: { readonly ko: string; readonly en: string };
  readonly executable: string;
  readonly sourceUrl: string;
  readonly method: string;
  readonly availability: 'installable' | 'manual';
  readonly reason: string | null;
  readonly installMethods?:readonly {readonly method:OfficialMethod;readonly label:string;readonly sourceUrl:string;readonly recommended:boolean}[];
  readonly updateSupport?: {readonly kind:'check-source'|'unsupported';readonly reason:string|null};
  readonly installations?:readonly CatalogInstallation[];
  readonly selectedInstallationId?:string|null;
  readonly configuredDefaultInstallationId?:string|null;
  readonly herdrLaunch?:{readonly status:'applied'|'unsupported'|'unavailable';readonly executable:string|null};
  readonly inventoryStatus?:'checking'|'ready'|'failed';
  readonly lastCheck?:CatalogCheck;
  readonly installed: { readonly path: string; readonly version: string | null; readonly managed: boolean;
    readonly identityPath?:string;readonly source?:'bun-global';
    readonly versionStatus?:'checking'|'known'|'unsupported'|'timeout'|'failed'|'unrecognized';
    readonly checkedAt?:number|null; readonly lastVerifiedVersion?:string|null } | null;
};
export type InstallJob = {
  readonly official?:OfficialInstallPlan|undefined;
  readonly makeDefault?:boolean|undefined;
  readonly previousInstallationId?:string|null|undefined;
  readonly id: string;
  readonly requestId: string;
  readonly catalogId: CatalogId;
  readonly revision: number;
  readonly stage: 'ready' | 'installing' | 'verifying' | 'completed' | 'failed' | 'uncertain';
  readonly sourceUrl: string;
  readonly method: string;
  readonly target: string;
  readonly archivePath?: string | null;
  readonly recipeHash: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly installedVersion: string | null;
  readonly executablePath: string | null;
  readonly failure: string | null;
  readonly log: readonly string[];
};
