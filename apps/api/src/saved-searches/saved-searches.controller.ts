import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  CreateSavedSearchDto,
  NewResultsDto,
  SavedSearchDto,
  SavedSearchIdParamDto,
  SavedSearchListDto,
  UpdateSavedSearchDto,
  type NewResults,
  type SavedSearch,
  type SavedSearchList,
} from './dto/saved-searches.dto';
import { SavedSearchesService } from './saved-searches.service';

/**
 * The signed-in user's saved searches (Q25, ADR 041). Global to the user
 * (§13.29): the same list in every tenant, matched by place across tenants.
 * Matching and alerts happen in the worker, never on these requests.
 */
@Controller({ path: 'saved-searches', version: '1' })
@UseGuards(JwtAuthGuard)
export class SavedSearchesController {
  constructor(private readonly savedSearches: SavedSearchesService) {}

  /** Checked like GET /search; at most saved_search_max_active active (409 beyond). */
  @Post()
  @ApiCreatedResponse({ type: SavedSearchDto })
  create(@Body() body: CreateSavedSearchDto): Promise<SavedSearch> {
    return this.savedSearches.create(body);
  }

  /** With each search's new-result count and the total (the app's badge). */
  @Get()
  @ApiOkResponse({ type: SavedSearchListDto })
  list(): Promise<SavedSearchList> {
    return this.savedSearches.list();
  }

  @Get(':id')
  @ApiOkResponse({ type: SavedSearchDto })
  get(@Param() params: SavedSearchIdParamDto): Promise<SavedSearch> {
    return this.savedSearches.get(params.id);
  }

  /** Change it; `active: true` resumes a paused search (limit applies again). */
  @Patch(':id')
  @ApiOkResponse({ type: SavedSearchDto })
  update(
    @Param() params: SavedSearchIdParamDto,
    @Body() body: UpdateSavedSearchDto,
  ): Promise<SavedSearch> {
    return this.savedSearches.update(params.id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  remove(@Param() params: SavedSearchIdParamDto): Promise<void> {
    return this.savedSearches.remove(params.id);
  }

  /** The new matches as cards; opening them marks them seen (and the search opened). */
  @Get(':id/new-results')
  @ApiOkResponse({ type: NewResultsDto })
  newResults(@Param() params: SavedSearchIdParamDto): Promise<NewResults> {
    return this.savedSearches.newResults(params.id);
  }
}
