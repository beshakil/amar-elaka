import 'package:json_annotation/json_annotation.dart';

part 'catalog_category.g.dart';

/// Mirrors `CatalogCategory` (apps/api/src/categories/dto/category-responses.dto.ts)
/// — one item of `GET /categories`: the categories enabled in the request's
/// tenant. `fieldSchema` is kept as JSON: the app's dynamic form parses it
/// (CategoryFieldSchema.fromJson), and a draft stores it as it came.
@JsonSerializable()
class CatalogCategory {
  const CatalogCategory({
    required this.id,
    required this.parentId,
    required this.slug,
    required this.kind,
    required this.name,
    required this.iconKey,
    required this.postExpiryDays,
    required this.requiresApproval,
    required this.fieldSchema,
  });

  factory CatalogCategory.fromJson(Map<String, dynamic> json) =>
      _$CatalogCategoryFromJson(json);

  final String id;
  final String? parentId;
  final String slug;
  final String kind;
  final LocalizedName name;
  final String? iconKey;
  final int? postExpiryDays;
  final bool requiresApproval;

  /// Null for module tiles (blood, notices…): nothing to post there.
  final Map<String, dynamic>? fieldSchema;

  Map<String, dynamic> toJson() => _$CatalogCategoryToJson(this);
}

@JsonSerializable()
class LocalizedName {
  const LocalizedName({required this.bn, required this.en});

  factory LocalizedName.fromJson(Map<String, dynamic> json) =>
      _$LocalizedNameFromJson(json);

  final String bn;
  final String en;

  String of(String locale) => locale == 'bn' ? bn : en;

  Map<String, dynamic> toJson() => _$LocalizedNameToJson(this);
}
