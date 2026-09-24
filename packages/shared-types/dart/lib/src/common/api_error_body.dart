import 'package:json_annotation/json_annotation.dart';

part 'api_error_body.g.dart';

/// Mirrors `ErrorBody` (apps/api/src/common/filters/global-exception.filter.ts)
/// — the JSON body of every non-2xx response. `error` is the domain
/// exception's `code` (e.g. `VALIDATION_FAILED`), never a stack trace.
@JsonSerializable()
class ApiErrorBody {
  const ApiErrorBody({
    required this.statusCode,
    required this.error,
    required this.message,
    this.details,
  });

  factory ApiErrorBody.fromJson(Map<String, dynamic> json) =>
      _$ApiErrorBodyFromJson(json);

  final int statusCode;
  final String error;
  final String message;

  /// Shape depends on `error`; for `VALIDATION_FAILED` it's a
  /// `ValidationIssue[]` — see [validationIssues].
  final Object? details;

  /// Parses [details] as validation issues when `error == 'VALIDATION_FAILED'`;
  /// null for every other error code or if the shape doesn't match.
  List<ValidationIssue>? get validationIssues {
    if (error != 'VALIDATION_FAILED' || details is! List) return null;
    try {
      return (details! as List)
          .map(
            (issue) => ValidationIssue.fromJson(issue as Map<String, dynamic>),
          )
          .toList();
    } on TypeError {
      return null;
    }
  }

  Map<String, dynamic> toJson() => _$ApiErrorBodyToJson(this);
}

/// Mirrors `ValidationIssue` (apps/api/src/common/exceptions/validation.exception.ts).
@JsonSerializable()
class ValidationIssue {
  const ValidationIssue({required this.path, required this.message});

  factory ValidationIssue.fromJson(Map<String, dynamic> json) =>
      _$ValidationIssueFromJson(json);

  final String path;
  final String message;

  Map<String, dynamic> toJson() => _$ValidationIssueToJson(this);
}
