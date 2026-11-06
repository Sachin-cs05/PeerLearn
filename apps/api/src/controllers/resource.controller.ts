import type { Request, Response, NextFunction } from 'express';
import { HTTP_STATUS } from '@peerlume/shared';
import { sendSuccess } from '../utils/apiResponse.js';
import {
  createResource,
  listResources,
  getResourceById,
  updateResource,
  deleteResource,
} from '../services/resource.service.js';
import { storageService } from '../services/storage.service.js';

export async function handleCreateResource(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const creatorId = req.user!.id;
    const body = req.body;
    const file = req.file;

    const resource = await createResource(creatorId, body, file);
    sendSuccess(res, resource, HTTP_STATUS.CREATED, 'Resource created successfully');
  } catch (error) {
    next(error);
  }
}

export async function handleListResources(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.user!.id;
    const type = req.query.type as any;
    const notesOnly = req.query.notesOnly === 'true';

    const resources = await listResources(userId, { type, notesOnly });
    sendSuccess(res, resources, HTTP_STATUS.OK);
  } catch (error) {
    next(error);
  }
}

export async function handleGetSessionResources(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.user!.id;
    const { sessionId } = req.params;

    const resources = await listResources(userId, { sessionId: sessionId as string });
    sendSuccess(res, resources, HTTP_STATUS.OK);
  } catch (error) {
    next(error);
  }
}

export async function handleGetResourceById(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.user!.id;
    const { resourceId } = req.params;

    const resource = await getResourceById(userId, resourceId as string);
    sendSuccess(res, resource, HTTP_STATUS.OK);
  } catch (error) {
    next(error);
  }
}

export async function handleDownloadFile(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.user!.id;
    const { resourceId } = req.params;

    const resource = await getResourceById(userId, resourceId as string);
    if (!resource.fileKey) {
      res.status(404).json({ success: false, error: { message: 'No file attachment on this resource' } });
      return;
    }

    // If client requested JSON presigned URL and cloud storage is active
    if ((req.query.format === 'json' || req.query.presigned === 'true') && storageService.isCloudStorage()) {
      const presignedUrl = await storageService.getDownloadUrl(resource.fileKey, 300);
      sendSuccess(res, { downloadUrl: presignedUrl, expiresInSeconds: 300 }, HTTP_STATUS.OK);
      return;
    }

    // If client requested presigned redirect and cloud storage is active, generate short-lived signed URL
    if (req.query.redirect === 'true' && storageService.isCloudStorage()) {
      const presignedUrl = await storageService.getDownloadUrl(resource.fileKey, 300);
      res.redirect(presignedUrl);
      return;
    }

    const { stream, size } = await storageService.getFileStream(resource.fileKey);

    res.setHeader('Content-Type', resource.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', size);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(resource.fileName || 'download')}"`
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');

    stream.pipe(res);
  } catch (error) {
    next(error);
  }
}

export async function handleUpdateResource(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.user!.id;
    const { resourceId } = req.params;

    const updated = await updateResource(userId, resourceId as string, req.body);
    sendSuccess(res, updated, HTTP_STATUS.OK, 'Resource updated successfully');
  } catch (error) {
    next(error);
  }
}

export async function handleDeleteResource(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.user!.id;
    const { resourceId } = req.params;

    await deleteResource(userId, resourceId as string);
    sendSuccess(res, null, HTTP_STATUS.OK, 'Resource deleted successfully');
  } catch (error) {
    next(error);
  }
}
