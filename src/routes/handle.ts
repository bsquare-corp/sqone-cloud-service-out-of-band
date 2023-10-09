import { HandleArg, handleRequest } from '@bsquare/base-service';
import { PipelineEvent } from '@bsquare/companion-common';
import { Request, RequestHandler, Response } from 'express';
import type { OutOfBandDb } from '../database';

export type RaiseEventCallback = (event: PipelineEvent) => Promise<void>;

export interface HandleData<T = Record<string, unknown>> extends Record<string, unknown> {
  db: OutOfBandDb;
  dispatchEvent: RaiseEventCallback;
  locals: T;

  // Provided by authenticate() middleware
  roleId: string;
  permissions: string[];
  tenantId: string;
}

export type Param = Record<string, string | string[] | Date>;
export type NestedParams = Record<string, string | string[] | Date | Param>;

const ACTION_METHODS = ['POST', 'PATCH', 'PUT'];

function isActionMethod(req: Request): boolean {
  return ACTION_METHODS.includes(req.method);
}

function extractor<T>({ res, req }: { res: Response; req: Request }): HandleData<T> {
  const params = { ...req.query } as unknown as Record<string, string>;
  const mappedParams: NestedParams = {};

  for (const [key, value] of Object.entries(params)) {
    let obj: Record<string, unknown> = mappedParams;
    let name: string = key;

    if (key.includes('.')) {
      const fields = key.split('.');
      for (const field of fields.slice(0, fields.length - 1)) {
        if (!obj[field] || typeof obj[field] !== 'object') {
          obj[field] = {};
        }
        obj = obj[field] as Record<string, unknown>;
      }
      name = fields[fields.length - 1];
    }

    if (typeof obj[name] === 'string') {
      obj[name] = [obj[name], value];
    } else if (Array.isArray(obj[name])) {
      (obj[name] as unknown[]).push(value);
    } else {
      obj[name] = value;
    }
  }

  const locals = res.locals as {
    db: OutOfBandDb;
    dispatchEvent: RaiseEventCallback;
    roleId: string;
    tenantId: string;
    permissions: string[];
  };

  return {
    db: locals.db,
    dispatchEvent: locals.dispatchEvent,
    roleId: locals.roleId,
    tenantId: locals.tenantId,
    permissions: locals.permissions,
    locals: res.locals as T,
    // For an action, eg POST only use the body.
    // Don't spread operator the body because if it's an array that breaks indexes.
    // For other methods eg GET, HEAD use the query parameters.
    params: isActionMethod(req) ? req.body : mappedParams,
  };
}

// Where T is the locals type.
export function handle<T = Record<string, unknown>>(
  opts: HandleArg<HandleData<T>>,
): RequestHandler {
  return handleRequest(opts, extractor);
}
