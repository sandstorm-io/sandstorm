// See comments in corresponding .js file.
declare module TAPi18n {
  export function __(msgCode: string, ...args: any[]): string;
  export function getLanguages(): Record<string, { name: string }>;
  export function setLanguage(lang: string): { done: (fn?: () => void) => any; fail: (fn?: (err?: any) => void) => any };
}
export { TAPi18n }
