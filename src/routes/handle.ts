import { HandleArg, handleRequest } from '@bsquare/base-service';
import { PipelineEvent } from '@bsquare/companion-common';
import { CloudFileApi, mapExpressParams } from '@bsquare/companion-service-common';
import { Request, RequestHandler, Response } from 'express';
import type { OutOfBandDb } from '../database';

export type RaiseEventCallback = (event: PipelineEvent) => Promise<void>;

export interface HandleData<T = Record<string, unknown>> extends Record<string, unknown> {
  db: OutOfBandDb;
  dispatchEvent: RaiseEventCallback;
  fileApi: CloudFileApi;
  locals: T;
}

function extractor<T>({ res, req }: { res: Response; req: Request }): HandleData<T> {

  const locals = res.locals as {
    db: OutOfBandDb;
    fileApi: CloudFileApi;
    dispatchEvent: RaiseEventCallback;
  };

  return {
    db: locals.db,
    fileApi: locals.fileApi,
    dispatchEvent: locals.dispatchEvent,
    locals: res.locals as T,
    params: mapExpressParams(req),
  };
}

// Where T is the locals type.
export function handle<T = Record<string, unknown>>(
  opts: HandleArg<HandleData<T>>,
): RequestHandler {
  return handleRequest(opts, extractor);
}
