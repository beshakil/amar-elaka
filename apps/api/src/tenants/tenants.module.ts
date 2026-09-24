import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

@Module({
  imports: [SettingsModule],
  controllers: [TenantsController],
  providers: [TenantsService],
})
export class TenantsModule {}
