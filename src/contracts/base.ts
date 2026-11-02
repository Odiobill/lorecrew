export type Id = string;
export type Revision = string;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Clock { now(): number }
export interface AppEvent { seq: number; id: string; kind: string; at: string; data: Json }
export interface OutboxRecord { id: Id; kind: string; payload: Json; state: 'pending' | 'done'; receipt?: Json }
export class AppError extends Error {
  constructor(public readonly code: string, message: string, public readonly details: Json = null) {
    super(message); this.name = 'AppError';
  }
}

/** Reject lossy JSON conversion (undefined, non-finite numbers, class instances, cycles). */
export function encodeJson(value: unknown): string {
  const ancestors = new Set<object>();
  const check = (item: unknown): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || item === null || ancestors.has(item)) throw invalid();
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw invalid();
    if (Object.getOwnPropertySymbols(item).length) throw invalid();
    ancestors.add(item);
    if (array) {
      // Only length and dense indexed data are permitted; hidden hooks cannot escape validation.
      if (Object.getOwnPropertyNames(item).length !== item.length + 1) throw invalid();
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, i);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw invalid();
        check(descriptor.value);
      }
    } else {
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(item))) {
        if (!descriptor.enumerable || !('value' in descriptor)) throw invalid();
        check(descriptor.value);
      }
    }
    ancestors.delete(item);
  };
  check(value);
  return JSON.stringify(value);
}
function invalid() { return new AppError('INVALID_JSON', 'Store values must be losslessly serializable JSON'); }
