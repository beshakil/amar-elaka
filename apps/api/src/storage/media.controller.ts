import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CreateUploadDto } from './dto/create-upload.dto';
import { MediaUploadsService, type CreateUploadResult } from './media-uploads.service';

@Controller({ path: 'media/uploads', version: '1' })
@UseGuards(JwtAuthGuard)
export class MediaController {
  constructor(private readonly uploads: MediaUploadsService) {}

  @Post()
  create(@Body() body: CreateUploadDto): Promise<CreateUploadResult> {
    return this.uploads.create(body);
  }

  @Post(':id/confirm')
  confirm(@Param('id') id: string): Promise<{ status: 'ready' }> {
    return this.uploads.confirm(id);
  }
}
