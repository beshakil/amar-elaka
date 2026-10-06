import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';

/** GET /map/features/:layer/:id: no public feature of that layer and id in that tenant. */
export class MapFeatureNotFoundException extends DomainException {
  readonly code = 'MAP_FEATURE_NOT_FOUND';
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('This place is no longer on the map.');
  }
}
