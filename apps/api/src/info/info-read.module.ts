import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { BazarBoardService } from './bazar-board.service';
import { InfoRepository } from './info.repository';

/**
 * The read side of the local information services that other modules show
 * (ADR 064): the feed's bazar and blood cards read the board and the request
 * summary here, without pulling in the info module's write side.
 */
@Module({
  imports: [SettingsModule],
  providers: [InfoRepository, BazarBoardService],
  exports: [InfoRepository, BazarBoardService],
})
export class InfoReadModule {}
