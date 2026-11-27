import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Param,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Res,
  StreamableFile,
  HttpCode,
  HttpStatus,
  Headers,
  Logger,
  PayloadTooLargeException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Express } from 'express';
import type { Response } from 'express';
import { diskStorage } from 'multer';
import { mkdtempSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { NoteAttachmentsService } from '../services/note-attachments.service';
import { ConvexAttachmentsService } from '../services/convex-attachments.service';
import { ReorderAttachmentsDto } from '../dto/reorder-attachments.dto';
import { ATTACHMENT_MAX_FILE_SIZE } from '../constants/notes.constants';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthGuard } from '../../auth/auth.guard';
import { assertValidAttachmentFile } from '../utils/attachment-storage.util';

let stagingDirectory: string | undefined;

@Controller('api/notes/:noteId/attachments')
@UseGuards(AuthGuard)
export class NoteAttachmentsController {
  private readonly logger = new Logger(NoteAttachmentsController.name);

  constructor(
    private readonly noteAttachmentsService: NoteAttachmentsService,
    private readonly convexAttachments: ConvexAttachmentsService,
  ) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, callback) => {
          try {
            stagingDirectory ??= mkdtempSync(
              join(tmpdir(), 'anchor-attachments-'),
            );
            callback(null, stagingDirectory);
          } catch (error) {
            callback(error as Error, '');
          }
        },
      }),
      defParamCharset: 'utf8',
      limits: { fileSize: ATTACHMENT_MAX_FILE_SIZE + 1, fields: 16 },
    }),
  )
  async upload(
    @CurrentUser('id') userId: string,
    @Param('noteId') noteId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    try {
      if (file?.size > ATTACHMENT_MAX_FILE_SIZE) {
        throw new PayloadTooLargeException('File too large');
      }
      if (this.convexAttachments.enabled) {
        assertValidAttachmentFile(file);
        return await this.convexAttachments.upload(userId, noteId, file);
      }
      if (file) file.buffer = await readFile(file.path);
      return await this.noteAttachmentsService.upload(userId, noteId, file);
    } finally {
      if (file?.path) {
        await rm(file.path, { force: true }).catch(() => {
          this.logger.warn('Could not remove a staged attachment');
        });
      }
    }
  }

  @Get()
  findAll(@CurrentUser('id') userId: string, @Param('noteId') noteId: string) {
    if (this.convexAttachments.enabled)
      return this.convexAttachments.list(userId, noteId);
    return this.noteAttachmentsService.findAll(userId, noteId);
  }

  @Get(':id')
  async serveFile(
    @CurrentUser('id') userId: string,
    @Param('noteId') noteId: string,
    @Param('id') attachmentId: string,
    @Res({ passthrough: true }) res: Response,
    @Headers('range') range?: string,
  ) {
    if (this.convexAttachments.enabled) {
      const response = await this.convexAttachments.download(
        userId,
        noteId,
        attachmentId,
        range,
      );
      res.status(response.status);
      for (const name of [
        'Content-Type',
        'Content-Length',
        'Content-Range',
        'Content-Disposition',
        'Cache-Control',
        'Accept-Ranges',
        'X-Content-Type-Options',
      ]) {
        const value = response.headers.get(name);
        if (value)
          res.set(
            name,
            name === 'Content-Disposition'
              ? value.replace(/^attachment/, 'inline')
              : value,
          );
      }
      if (!response.body) return new StreamableFile(new Uint8Array());
      return new StreamableFile(
        Readable.fromWeb(
          response.body as unknown as ReadableStream<Uint8Array>,
        ),
      );
    }
    const { stream, attachment } = await this.noteAttachmentsService.serveFile(
      userId,
      noteId,
      attachmentId,
    );

    res.set({
      'Content-Type': attachment.mimeType,
      'Content-Disposition': `inline; filename="${encodeURIComponent(attachment.originalFilename)}"`,
      'Content-Length': attachment.fileSize.toString(),
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });

    return new StreamableFile(stream);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(
    @CurrentUser('id') userId: string,
    @Param('noteId') noteId: string,
    @Param('id') attachmentId: string,
  ) {
    if (this.convexAttachments.enabled)
      return this.convexAttachments.remove(userId, noteId, attachmentId);
    return this.noteAttachmentsService.remove(userId, noteId, attachmentId);
  }

  @Patch('reorder')
  reorder(
    @CurrentUser('id') userId: string,
    @Param('noteId') noteId: string,
    @Body() dto: ReorderAttachmentsDto,
  ) {
    if (this.convexAttachments.enabled)
      return this.convexAttachments.reorder(userId, noteId, dto.orderedIds);
    return this.noteAttachmentsService.reorder(userId, noteId, dto.orderedIds);
  }
}
