import {
  BadGatewayException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { issueConvexToken } from '../../auth/convex-token';
import type { AttachmentResponseDto } from '../dto/attachment-response.dto';

@Injectable()
export class ConvexAttachmentsService {
  get enabled(): boolean {
    return Boolean(process.env.ANCHOR_CONVEX_ATTACHMENT_ORIGIN?.trim());
  }

  private async request(
    userId: string,
    method: string,
    path: string,
    params: Record<string, string>,
    init: Pick<RequestInit, 'body' | 'headers'> = {},
  ): Promise<Response> {
    let url: URL;
    try {
      const origin = new URL(process.env.ANCHOR_CONVEX_ATTACHMENT_ORIGIN ?? '');
      if (
        !['http:', 'https:'].includes(origin.protocol) ||
        origin.username ||
        origin.password ||
        origin.pathname !== '/' ||
        origin.search ||
        origin.hash
      ) {
        throw new Error('Invalid Convex origin');
      }
      url = new URL('/api/compose/attachments' + path, origin);
      url.search = new URLSearchParams(params).toString();
    } catch {
      throw new ServiceUnavailableException(
        'Convex attachments are not configured',
      );
    }
    const token = issueConvexToken(userId);
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers,
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new BadGatewayException('Could not reach Convex attachments');
    }
    if (response.ok || (method === 'GET' && response.status === 416))
      return response;
    await response.body?.cancel();
    switch (response.status) {
      case 400:
      case 411:
      case 415:
        throw new HttpException('Invalid attachment request', 400);
      case 404:
        throw new HttpException('Note or attachment not found', 404);
      case 413:
        throw new HttpException('File too large', 413);
      default:
        throw new BadGatewayException('Convex attachment request failed');
    }
  }

  async upload(userId: string, noteId: string, file: Express.Multer.File) {
    const body = await openAsBlob(file.path, { type: file.mimetype });
    const response = await this.request(
      userId,
      'POST',
      '',
      { noteId, attachmentId: randomUUID() },
      {
        body,
        headers: {
          'X-Anchor-Filename-Encoded': encodeURIComponent(file.originalname),
        },
      },
    );
    const attachment = (await response.json()) as Omit<
      AttachmentResponseDto,
      'position'
    >;
    return { ...attachment, position: 0 };
  }

  async list(userId: string, noteId: string): Promise<AttachmentResponseDto[]> {
    const response = await this.request(userId, 'GET', '/list', { noteId });
    return (await response.json()) as AttachmentResponseDto[];
  }

  download(
    userId: string,
    noteId: string,
    attachmentId: string,
    range?: string,
  ) {
    return this.request(
      userId,
      'GET',
      '',
      { noteId, attachmentId },
      {
        headers: range ? { Range: range } : {},
      },
    );
  }

  async remove(userId: string, noteId: string, attachmentId: string) {
    const response = await this.request(userId, 'DELETE', '', {
      noteId,
      attachmentId,
    });
    return (await response.json()) as { success: boolean };
  }

  async reorder(userId: string, noteId: string, orderedIds: string[]) {
    const response = await this.request(
      userId,
      'PATCH',
      '/list',
      { noteId },
      {
        body: JSON.stringify({ orderedIds }),
        headers: { 'Content-Type': 'application/json' },
      },
    );
    return (await response.json()) as AttachmentResponseDto[];
  }
}
