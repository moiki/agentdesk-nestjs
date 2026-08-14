import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantContext {
  tenantId: string;
  userId?: string;
  role?: string;
}

export const tenantContextStore = new AsyncLocalStorage<TenantContext>();

export function getTenantContext(): TenantContext | undefined {
  return tenantContextStore.getStore();
}

export function getTenantId(): string | undefined {
  return getTenantContext()?.tenantId;
}
