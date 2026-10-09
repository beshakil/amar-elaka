import 'package:amar_elaka_app/features/my_store/domain/hours_draft.dart';
import 'package:amar_elaka_app/features/store/data/store_models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('HoursDraft', () {
    test(
      'reads split shifts per day, Saturday first, and writes them back',
      () {
        const weekly = [
          WeeklyRange(day: 6, opens: '15:00', closes: '21:00'),
          WeeklyRange(day: 6, opens: '09:00', closes: '13:00'),
          WeeklyRange(day: 1, opens: '10:00', closes: '02:00'),
        ];
        final draft = HoursDraft.fromWeekly(weekly);
        expect(draft.days.keys.first, 6);
        expect(draft.days[6], [
          Shift.parse('09:00', '13:00'),
          Shift.parse('15:00', '21:00'),
        ]);
        expect(draft.isOpen(5), isFalse);
        expect(draft.days[1]!.single.overnight, isTrue);
        expect(draft.toWeekly(), [weekly[1], weekly[0], weekly[2]]);
        expect(draft.issues(), isEmpty);
      },
    );

    test(
      'finds overlapping shifts and equal times; a past-midnight shift is fine',
      () {
        final draft = HoursDraft({
          6: [Shift.parse('09:00', '14:00'), Shift.parse('13:00', '18:00')],
          7: [Shift.parse('10:00', '10:00')],
          1: [Shift.parse('18:00', '01:00')],
        });
        expect(draft.issues().map((i) => (i.runtimeType, i.day)), [
          (Overlap, 6),
          (SameTimes, 7),
        ]);
      },
    );

    test(
      'opens a closed day with the default, adds a later shift, copies a day to all',
      () {
        final draft = HoursDraft({})..setOpen(2, open: true);
        expect(draft.days[2], [HoursDraft.defaultShift]);
        draft
          ..setShift(2, 0, Shift.parse('09:00', '13:00'))
          ..addShift(2);
        expect(draft.days[2]!.last, Shift.parse('14:00', '16:00'));
        expect(draft.issues(), isEmpty);
        draft.copyToAll(2);
        expect(weekOrder.every((d) => draft.days[d]!.length == 2), isTrue);
        draft.setOpen(2, open: false);
        expect(draft.isOpen(2), isFalse);
      },
    );
  });
}
