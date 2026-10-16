/// Field agent mode's data as the API sends it (apps/api/src/agents, ADR 066).
/// Hand-written readers: small shapes, read defensively.
library;

double _num(Object? v) => (v as num).toDouble();

class AgentTargets {
  const AgentTargets({this.dailyShops, this.weeklyShops});

  factory AgentTargets.fromJson(Map<String, dynamic> j) => AgentTargets(
    dailyShops: (j['dailyShops'] as num?)?.toInt(),
    weeklyShops: (j['weeklyShops'] as num?)?.toInt(),
  );

  final int? dailyShops;
  final int? weeklyShops;

  Map<String, Object?> toJson() => {
    'dailyShops': dailyShops,
    'weeklyShops': weeklyShops,
  };
}

/// Who I am as an agent, and what the phone must know offline.
class AgentMe {
  const AgentMe({
    required this.id,
    required this.code,
    required this.status,
    required this.targets,
    required this.minGpsAccuracyM,
    required this.photosMax,
    required this.captureMaxAgeDays,
  });

  factory AgentMe.fromJson(Map<String, dynamic> j) {
    final agent = j['agent'] as Map<String, dynamic>;
    final settings = j['settings'] as Map<String, dynamic>;
    return AgentMe(
      id: agent['id'] as String,
      code: agent['code'] as String,
      status: agent['status'] as String,
      targets: AgentTargets.fromJson(agent['targets'] as Map<String, dynamic>),
      minGpsAccuracyM: _num(settings['minGpsAccuracyM']),
      photosMax: (settings['photosMax'] as num).toInt(),
      captureMaxAgeDays: (settings['captureMaxAgeDays'] as num).toInt(),
    );
  }

  final String id;
  final String code;
  final String status;
  final AgentTargets targets;

  /// agent_min_gps_accuracy_m: the capture can't be saved with a worse fix.
  final double minGpsAccuracyM;
  final int photosMax;
  final int captureMaxAgeDays;

  Map<String, Object?> toJson() => {
    'agent': {
      'id': id,
      'code': code,
      'status': status,
      'targets': targets.toJson(),
    },
    'settings': {
      'minGpsAccuracyM': minGpsAccuracyM,
      'photosMax': photosMax,
      'captureMaxAgeDays': captureMaxAgeDays,
    },
  };
}

/// A place category the agent can pick (kept for offline capture).
class AgentCategory {
  const AgentCategory({
    required this.id,
    required this.nameBn,
    this.nameEn,
    this.iconKey,
  });

  factory AgentCategory.fromJson(Map<String, dynamic> j) => AgentCategory(
    id: j['id'] as String,
    nameBn: j['nameBn'] as String,
    nameEn: j['nameEn'] as String?,
    iconKey: j['iconKey'] as String?,
  );

  final String id;
  final String nameBn;
  final String? nameEn;
  final String? iconKey;

  Map<String, Object?> toJson() => {
    'id': id,
    'nameBn': nameBn,
    'nameEn': nameEn,
    'iconKey': iconKey,
  };
}

class AgentTask {
  const AgentTask({
    required this.id,
    required this.type,
    required this.title,
    required this.status,
    required this.dueOn,
    this.notes,
    this.placeId,
    this.placeName,
    this.localityName,
    this.lat,
    this.lng,
  });

  factory AgentTask.fromJson(Map<String, dynamic> j) {
    final at = j['location'] as Map<String, dynamic>?;
    return AgentTask(
      id: j['id'] as String,
      type: j['type'] as String,
      title: j['title'] as String,
      status: j['status'] as String,
      dueOn: j['dueOn'] as String,
      notes: j['notes'] as String?,
      placeId: j['placeId'] as String?,
      placeName: j['placeName'] as String?,
      localityName: j['localityName'] as String?,
      lat: at == null ? null : _num(at['lat']),
      lng: at == null ? null : _num(at['lng']),
    );
  }

  final String id;

  /// map_shop | verify_shop | update_info.
  final String type;
  final String title;

  /// open | done.
  final String status;
  final String dueOn;
  final String? notes;
  final String? placeId;
  final String? placeName;
  final String? localityName;
  final double? lat;
  final double? lng;

  bool get done => status == 'done';
}

class AgentToday {
  const AgentToday({
    required this.date,
    required this.tasks,
    required this.done,
    required this.remaining,
  });

  factory AgentToday.fromJson(Map<String, dynamic> j) => AgentToday(
    date: j['date'] as String,
    tasks: [
      for (final t in j['tasks'] as List)
        AgentTask.fromJson(t as Map<String, dynamic>),
    ],
    done: (j['done'] as num).toInt(),
    remaining: (j['remaining'] as num).toInt(),
  );

  final String date;
  final List<AgentTask> tasks;
  final int done;
  final int remaining;
}

class OutcomeCounts {
  const OutcomeCounts({
    required this.submitted,
    required this.approved,
    required this.rejected,
    required this.pending,
    required this.commission,
  });

  factory OutcomeCounts.fromJson(Map<String, dynamic> j) => OutcomeCounts(
    submitted: (j['submitted'] as num).toInt(),
    approved: (j['approved'] as num).toInt(),
    rejected: (j['rejected'] as num).toInt(),
    pending: (j['pending'] as num).toInt(),
    commission: j['commission'] as String,
  );

  final int submitted;
  final int approved;
  final int rejected;
  final int pending;

  /// Taka as the API's decimal string (never a float).
  final String commission;
}

class SubmissionOutcome {
  const SubmissionOutcome({
    required this.id,
    required this.kind,
    required this.capturedAt,
    required this.reviewStatus,
    required this.fraudFlags,
    required this.commission,
    this.name,
    this.reasonCode,
    this.reasonText,
  });

  factory SubmissionOutcome.fromJson(Map<String, dynamic> j) =>
      SubmissionOutcome(
        id: j['id'] as String,
        kind: j['kind'] as String,
        capturedAt: DateTime.parse(j['capturedAt'] as String),
        reviewStatus: j['reviewStatus'] as String,
        fraudFlags: [for (final f in j['fraudFlags'] as List) f as String],
        commission: j['commission'] as String,
        name: j['name'] as String?,
        reasonCode: j['reasonCode'] as String?,
        reasonText: j['reasonText'] as String?,
      );

  final String id;
  final String kind;
  final DateTime capturedAt;

  /// pending | approved | rejected.
  final String reviewStatus;
  final List<String> fraudFlags;
  final String commission;
  final String? name;
  final String? reasonCode;
  final String? reasonText;
}

class AgentStats {
  const AgentStats({
    required this.today,
    required this.week,
    required this.weekStartsOn,
    required this.targets,
    required this.recent,
  });

  factory AgentStats.fromJson(Map<String, dynamic> j) => AgentStats(
    today: OutcomeCounts.fromJson(j['today'] as Map<String, dynamic>),
    week: OutcomeCounts.fromJson(j['week'] as Map<String, dynamic>),
    weekStartsOn: j['weekStartsOn'] as String,
    targets: AgentTargets.fromJson(j['targets'] as Map<String, dynamic>),
    recent: [
      for (final r in j['recent'] as List)
        SubmissionOutcome.fromJson(r as Map<String, dynamic>),
    ],
  );

  final OutcomeCounts today;
  final OutcomeCounts week;
  final String weekStartsOn;
  final AgentTargets targets;
  final List<SubmissionOutcome> recent;
}

/// A shop already on the map that the capture may be.
class DuplicateCandidate {
  const DuplicateCandidate({
    required this.placeId,
    required this.nameBn,
    required this.distanceM,
    required this.phoneMatch,
    this.nameEn,
  });

  factory DuplicateCandidate.fromJson(Map<String, dynamic> j) =>
      DuplicateCandidate(
        placeId: j['placeId'] as String,
        nameBn: j['nameBn'] as String,
        nameEn: j['nameEn'] as String?,
        distanceM: _num(j['distanceM']),
        phoneMatch: j['phoneMatch'] as bool? ?? false,
      );

  final String placeId;
  final String nameBn;
  final String? nameEn;
  final double distanceM;
  final bool phoneMatch;

  Map<String, Object?> toJson() => {
    'placeId': placeId,
    'nameBn': nameBn,
    'nameEn': nameEn,
    'distanceM': distanceM,
    'phoneMatch': phoneMatch,
  };
}

/// The server's answer to one upload of a submission.
class SubmissionResult {
  const SubmissionResult({
    required this.id,
    required this.status,
    required this.fraudFlags,
    required this.candidates,
    this.placeId,
  });

  factory SubmissionResult.fromJson(Map<String, dynamic> j) => SubmissionResult(
    id: j['id'] as String,
    status: j['status'] as String,
    placeId: j['placeId'] as String?,
    fraudFlags: [for (final f in j['fraudFlags'] as List) f as String],
    candidates: [
      for (final c in j['candidates'] as List)
        DuplicateCandidate.fromJson(c as Map<String, dynamic>),
    ],
  );

  final String id;

  /// created | needs_decision.
  final String status;
  final String? placeId;
  final List<String> fraudFlags;
  final List<DuplicateCandidate> candidates;
}
