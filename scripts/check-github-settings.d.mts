// Types for tests and editors; the script itself is plain JavaScript.
export const REPOSITORY: string;
export const ENVIRONMENT: string;
export const BRANCH: string;
export const REQUIRED_CHECK: string;
export const TAG_PATTERN: string;
export class Unreadable extends Error {}
export interface Reply {
  status: number;
  body: any;
}
export type Reader = (path: string) => Promise<Reply>;
export interface SettingResult {
  id: string;
  title: string;
  state: "ok" | "missing" | "unknown";
  detail: string;
  fix: string;
}
export function parseReply(output: string): Reply;
export function ghReader(repository: string): Reader;
export function auditSettings(get: Reader): Promise<SettingResult[]>;
export function exitStatus(results: readonly SettingResult[]): 0 | 1 | 2;
export function formatReport(repository: string, results: readonly SettingResult[]): string;
