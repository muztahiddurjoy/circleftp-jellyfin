import {
  createDownloadSchema,
  deleteDownloadQuerySchema,
  downloadListQuerySchema,
} from '@cfj/shared';
import { Router } from 'express';

import { requireAuth } from '../auth/middleware.js';
import { CircleFtpError } from '../circleftp/types.js';
import { downloadQueue } from '../downloads/queue.js';
import {
  createDownload,
  deleteDownload,
  getDownload,
  listDownloads,
  requestCancel,
  retryDownload,
} from '../downloads/service.js';
import { ApiError } from '../lib/errors.js';
import { asyncHandler, parseBody, parseQuery } from '../lib/http.js';

export const downloadsRouter: Router = Router();

downloadsRouter.use('/downloads', requireAuth);

downloadsRouter.get(
  '/downloads',
  asyncHandler(async (req, res) => {
    const { status, limit } = parseQuery(downloadListQuerySchema, req.query);
    res.json({ downloads: await listDownloads(status, limit) });
  }),
);

downloadsRouter.get(
  '/downloads/:id',
  asyncHandler(async (req, res) => {
    res.json(await getDownload(String(req.params.id)));
  }),
);

/** "Add to Jellyfin". */
downloadsRouter.post(
  '/downloads',
  asyncHandler(async (req, res) => {
    const { postId, seasons } = parseBody(createDownloadSchema, req.body);

    let download;
    try {
      download = await createDownload({
        postId,
        seasons: seasons ?? [],
        userId: req.user!.id,
      });
    } catch (error) {
      if (error instanceof CircleFtpError) {
        throw error.status === 404
          ? ApiError.notFound('That title is no longer on Circle FTP')
          : ApiError.upstream(error.message);
      }
      throw error;
    }

    // The worker picks it up on the next tick; the response does not wait.
    downloadQueue.wake();
    res.status(201).json(download);
  }),
);

downloadsRouter.post(
  '/downloads/:id/cancel',
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const download = await requestCancel(id);
    // Interrupt the in-flight transfer rather than waiting for the next file.
    downloadQueue.abort(id);
    res.json(download);
  }),
);

downloadsRouter.post(
  '/downloads/:id/retry',
  asyncHandler(async (req, res) => {
    const download = await retryDownload(String(req.params.id));
    downloadQueue.wake();
    res.json(download);
  }),
);

downloadsRouter.delete(
  '/downloads/:id',
  asyncHandler(async (req, res) => {
    const { deleteFiles } = parseQuery(deleteDownloadQuerySchema, req.query);
    await deleteDownload(String(req.params.id), deleteFiles);
    res.json({ ok: true });
  }),
);
