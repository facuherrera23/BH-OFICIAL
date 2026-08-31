declare const Deno: {
  serve: (handler: (req: Request) => Response | Promise<Response>) => void;
  env: { get: (key: string) => string | undefined };
};

declare module 'npm:@supabase/supabase-js@2' {
  export function createClient(url: string, key: string, opts?: any): any;
}

declare module '../_shared/audit.ts' {
  export function auditEvent(...args: any[]): any;
  export function auditSensitiveAction(...args: any[]): any;
  export function trackToolUsage(...args: any[]): any;
  export function auditError(...args: any[]): any;
  export function getClientIp(...args: any[]): any;
  export function getUserAgent(...args: any[]): any;
  export function genRequestId(...args: any[]): any;
}