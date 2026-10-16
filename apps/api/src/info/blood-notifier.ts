import { Injectable, Logger } from '@nestjs/common';
import { NotificationService } from '../notifications/notification.service';
import { BLOOD_DEEP_LINKS, BLOOD_GROUP_SYMBOL } from './blood-groups';
import type { BloodGroup } from './dto/info.dto';
import type { AlertRow } from './info.repository';

// settings-exempt: unit conversion for the template's "about N km"
const METRES_PER_KM = 1000;

/**
 * Blood notices (ADR 064). A notice never fails what it reports: the request
 * or the contact is committed first; a queueing failure is logged (the alert
 * job does not re-send an alert that was recorded).
 */
@Injectable()
export class BloodNotifier {
  private readonly logger = new Logger(BloodNotifier.name);

  constructor(private readonly notifications: NotificationService) {}

  /** One push per matched donor (blood_request_alert_donors already applied every cap). */
  async alerts(
    request: { id: string; bloodGroup: string; units: number; hospitalName: string },
    alerts: readonly AlertRow[],
  ): Promise<void> {
    for (const a of alerts) {
      await this.safely(`blood_request_nearby:${request.id}`, () =>
        this.notifications.send({
          userId: a.donor_user_id,
          type: 'blood_request_nearby',
          tenantId: a.donor_tenant_id,
          params: {
            group: BLOOD_GROUP_SYMBOL[request.bloodGroup as BloodGroup] ?? request.bloodGroup,
            hospital: request.hospitalName,
            units: String(request.units),
            distanceKm: String(Math.max(1, Math.round(a.distance_m / METRES_PER_KM))),
          },
          deepLink: BLOOD_DEEP_LINKS.request(request.id),
          entityId: request.id,
          dedupeKey: `blood_request_nearby:${request.id}:${a.donor_user_id}`,
        }),
      );
    }
  }

  /** Tells a donor someone asked for them; they see who in "who contacted me". */
  async contacted(
    donorUserId: string,
    tenantId: string,
    contactId: string,
    params: { requesterName: string | null; hospital: string | null },
  ): Promise<void> {
    await this.safely(`blood_donor_contacted:${contactId}`, () =>
      this.notifications.send({
        userId: donorUserId,
        type: 'blood_donor_contacted',
        tenantId,
        params,
        deepLink: BLOOD_DEEP_LINKS.myContacts,
        entityId: contactId,
        dedupeKey: `blood_donor_contacted:${contactId}`,
      }),
    );
  }

  private async safely(what: string, send: () => Promise<unknown>): Promise<void> {
    try {
      await send();
    } catch (error) {
      this.logger.warn(`could not queue ${what}: ${String(error)}`);
    }
  }
}
