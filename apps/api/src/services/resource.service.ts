import { prisma } from '../config/prisma.js';
import { AppError } from '../middleware/errorHandler.js';
import { HTTP_STATUS } from '@peerlume/shared';
import type {
  LearningResourceDto,
  CreateResourceInput,
  UpdateResourceInput,
  ResourceType,
} from '@peerlume/shared';
import { storageService } from './storage.service.js';
import { storageReconciliation } from './storage/reconciliation.service.js';
import { logger } from '../utils/logger.js';
import { checkBlockBetween } from './chat.service.js';

export function formatLearningResourceDto(r: any): LearningResourceDto {
  return {
    id: r.id,
    creatorId: r.creatorId,
    creatorName: r.creator?.fullName || 'Student',
    creatorAvatar: r.creator?.avatarUrl || null,
    sessionId: r.sessionId || null,
    sessionTitle: r.session?.title || null,
    targetUserId: r.targetUserId || null,
    type: r.type as ResourceType,
    title: r.title,
    description: r.description || null,
    content: r.content || null,
    url: r.url || null,
    language: r.language || null,
    codeLanguage: r.language || null,
    fileKey: r.fileKey || null,
    fileName: r.fileName || null,
    fileSize: r.fileSize || null,
    mimeType: r.mimeType || null,
    isPrivate: r.isPrivate,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  } as any;
}

function validateUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error();
    }
    return parsed.toString();
  } catch {
    throw new AppError('Invalid URL. Only http:// and https:// URLs are permitted.', HTTP_STATUS.BAD_REQUEST);
  }
}

export async function createResource(
  creatorId: string,
  input: CreateResourceInput,
  file?: { buffer: Buffer; originalname: string; mimetype: string }
): Promise<LearningResourceDto> {
  const { sessionId, targetUserId, type, title, description, content, url, language, isPrivate } = input;

  if (!title?.trim()) {
    throw new AppError('Resource title is required', HTTP_STATUS.BAD_REQUEST);
  }

  // Validate session access if attached to a session
  if (sessionId) {
    const session = await prisma.learningSession.findUnique({
      where: { id: sessionId },
      include: { participants: true },
    });
    if (!session) {
      throw new AppError('Associated learning session not found', HTTP_STATUS.NOT_FOUND);
    }
    const isMember =
      session.organizerId === creatorId || session.participants.some((p) => p.userId === creatorId);
    if (!isMember) {
      throw new AppError('Unauthorized: You are not a participant in this session', HTTP_STATUS.FORBIDDEN);
    }
  }

  // Validate target user if sharing directly
  if (targetUserId) {
    const isBlocked = await checkBlockBetween(creatorId, targetUserId);
    if (isBlocked) {
      throw new AppError('Cannot share resource due to privacy settings or blocks', HTTP_STATUS.FORBIDDEN);
    }
  }

  const rawType = ((type as string) === 'CODE_SNIPPET' ? 'CODE' : type) as ResourceType;
  const effectiveLang = language || (input as any).codeLanguage || 'typescript';

  // Handle URL validation for LINK type
  let sanitizedUrl: string | null = null;
  if (rawType === 'LINK') {
    if (!url?.trim()) {
      throw new AppError('URL is required for LINK resource type', HTTP_STATUS.BAD_REQUEST);
    }
    sanitizedUrl = validateUrl(url.trim());
  }

  // Handle File Upload for DOCUMENT type
  let fileMeta: { fileKey: string; originalName: string; mimeType: string; sizeBytes: number } | null = null;
  if (rawType === 'DOCUMENT' && file) {
    fileMeta = await storageService.saveFile(file.buffer, file.originalname, file.mimetype);
  }

  try {
    const effectiveIsPrivate =
      isPrivate !== undefined && isPrivate !== null
        ? Boolean(isPrivate)
        : !sessionId && !targetUserId
          ? true
          : false;

    const resource = await prisma.learningResource.create({
      data: {
        creatorId,
        sessionId: sessionId || null,
        targetUserId: targetUserId || null,
        type: rawType,
        title: title.trim(),
        description: description?.trim() || null,
        content: rawType === 'CODE' ? (content ?? null) : (content ? content.trim() : null),
        url: sanitizedUrl,
        language: rawType === 'CODE' ? effectiveLang : null,
        fileKey: fileMeta?.fileKey || null,
        fileName: fileMeta?.originalName || null,
        fileSize: fileMeta?.sizeBytes || null,
        mimeType: fileMeta?.mimeType || null,
        isPrivate: effectiveIsPrivate,
      },
      include: {
        creator: { select: { id: true, fullName: true, avatarUrl: true } },
        session: { select: { id: true, title: true } },
      },
    });

    return formatLearningResourceDto(resource);
  } catch (dbError: any) {
    // Compensating Transaction: Cleanup orphaned storage object if database persistence fails
    if (fileMeta?.fileKey) {
      try {
        await storageService.deleteFile(fileMeta.fileKey);
        logger.info('[STORAGE_COMPENSATION] Successfully rolled back storage object after DB error', {
          fileKey: fileMeta.fileKey,
        });
      } catch (compensatingError: any) {
        // Compensating deletion failed! Register the orphaned key
        try {
          await storageReconciliation.recordOrphanStorageKey(
            fileMeta.fileKey,
            'COMPENSATING_CLEANUP_FAILED',
            compensatingError?.message
          );
        } catch (reconcileErr: any) {
          logger.error('[STORAGE_RECONCILIATION_CRITICAL] Failed to record orphan task during compensating failure', {
            fileKey: fileMeta.fileKey,
            error: reconcileErr?.message,
          });
        }
        logger.error('[STORAGE_RECONCILIATION] Failed compensating cleanup of storage object after DB failure', {
          fileKey: fileMeta.fileKey,
          dbError: dbError?.message,
          compensatingError: compensatingError?.message,
        });
      }
    }
    throw dbError;
  }
}

export async function listResources(
  userId: string,
  filters: { sessionId?: string; type?: ResourceType; notesOnly?: boolean } = {}
): Promise<LearningResourceDto[]> {
  const where: any = {};

  if (filters.sessionId) {
    // Check user is participant in session
    const session = await prisma.learningSession.findUnique({
      where: { id: filters.sessionId },
      include: { participants: true },
    });
    if (!session) {
      throw new AppError('Learning session not found', HTTP_STATUS.NOT_FOUND);
    }
    const isMember =
      session.organizerId === userId || session.participants.some((p) => p.userId === userId);
    if (!isMember) {
      throw new AppError('Unauthorized access to session workspace', HTTP_STATUS.FORBIDDEN);
    }

    where.sessionId = filters.sessionId;
  } else if (filters.notesOnly) {
    where.type = 'NOTE';
    where.OR = [
      { creatorId: userId },
      { targetUserId: userId },
      {
        session: {
          OR: [
            { organizerId: userId },
            { participants: { some: { userId } } },
          ],
        },
      },
    ];
  } else {
    // General user workspace items
    where.OR = [
      { creatorId: userId },
      { targetUserId: userId },
      {
        session: {
          OR: [
            { organizerId: userId },
            { participants: { some: { userId } } },
          ],
        },
      },
    ];
  }

  if (filters.type) {
    where.type = filters.type;
  }

  const items = await prisma.learningResource.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      creator: { select: { id: true, fullName: true, avatarUrl: true } },
      session: { select: { id: true, title: true } },
    },
  });

  return items.map(formatLearningResourceDto);
}

export async function getResourceById(userId: string, resourceId: string): Promise<LearningResourceDto> {
  const resource = await prisma.learningResource.findUnique({
    where: { id: resourceId },
    include: {
      creator: { select: { id: true, fullName: true, avatarUrl: true } },
      session: {
        include: { participants: true },
      },
    },
  });

  if (!resource) {
    throw new AppError('Learning resource not found', HTTP_STATUS.NOT_FOUND);
  }

  // Authorization check
  const isCreator = resource.creatorId === userId;
  const isTarget = resource.targetUserId === userId;
  const isSessionMember =
    resource.session &&
    (resource.session.organizerId === userId ||
      resource.session.participants.some((p) => p.userId === userId));

  if (!isCreator && !isTarget && !isSessionMember) {
    throw new AppError('Unauthorized access to this resource', HTTP_STATUS.FORBIDDEN);
  }

  // If marked private, strictly creator only
  if (resource.isPrivate && !isCreator) {
    throw new AppError('This resource is private to its author', HTTP_STATUS.FORBIDDEN);
  }

  return formatLearningResourceDto(resource);
}

export async function updateResource(
  userId: string,
  resourceId: string,
  input: UpdateResourceInput
): Promise<LearningResourceDto> {
  const resource = await prisma.learningResource.findUnique({
    where: { id: resourceId },
  });

  if (!resource) {
    throw new AppError('Learning resource not found', HTTP_STATUS.NOT_FOUND);
  }

  if (resource.creatorId !== userId) {
    throw new AppError('Unauthorized: Only the creator can edit this resource', HTTP_STATUS.FORBIDDEN);
  }

  const updateData: any = {};
  if (input.title?.trim()) updateData.title = input.title.trim();
  if (input.description !== undefined) updateData.description = input.description?.trim() || null;
  if (input.content !== undefined) updateData.content = input.content ? input.content.trim() : null;
  if (input.url && resource.type === 'LINK') updateData.url = validateUrl(input.url.trim());
  if (input.language && resource.type === 'CODE') updateData.language = input.language;
  if (input.isPrivate !== undefined) updateData.isPrivate = Boolean(input.isPrivate);

  const updated = await prisma.learningResource.update({
    where: { id: resourceId },
    data: updateData,
    include: {
      creator: { select: { id: true, fullName: true, avatarUrl: true } },
      session: { select: { id: true, title: true } },
    },
  });

  return formatLearningResourceDto(updated);
}

export async function deleteResource(userId: string, resourceId: string): Promise<void> {
  const resource = await prisma.learningResource.findUnique({
    where: { id: resourceId },
  });

  if (!resource) {
    throw new AppError('Learning resource not found', HTTP_STATUS.NOT_FOUND);
  }

  if (resource.creatorId !== userId) {
    throw new AppError('Unauthorized: Only the creator can delete this resource', HTTP_STATUS.FORBIDDEN);
  }

  const fileKey = resource.fileKey;

  // Delete associated file if document
  if (fileKey) {
    await storageService.deleteFile(fileKey);
  }

  try {
    await prisma.learningResource.delete({
      where: { id: resourceId },
    });
  } catch (dbError: any) {
    // R2 object was deleted, but DB record deletion failed!
    // Best-effort clear fileKey so the record no longer points to a deleted storage object
    try {
      await prisma.learningResource.update({
        where: { id: resourceId },
        data: { fileKey: null },
      });
    } catch {
      // Best-effort; if DB connection is completely down, reconciliation task handles it
    }

    try {
      await storageReconciliation.recordDanglingDbResource(
        resourceId,
        fileKey,
        'DB_DELETE_FAILED',
        dbError?.message
      );
    } catch (reconcileErr: any) {
      logger.error('[STORAGE_RECONCILIATION_CRITICAL] Failed to record dangling task during delete failure', {
        resourceId,
        fileKey,
        error: reconcileErr?.message,
      });
    }

    logger.error('[STORAGE_RECONCILIATION] DB record deletion failed after storage deletion', {
      resourceId,
      fileKey,
      error: dbError?.message,
    });

    throw new AppError(
      'Failed to finalize resource record deletion. Task registered for durable reconciliation.',
      HTTP_STATUS.INTERNAL_SERVER_ERROR
    );
  }
}
