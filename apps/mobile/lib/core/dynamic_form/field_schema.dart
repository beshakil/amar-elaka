/// A category's field schema as GET /categories serves it (`fieldSchema`),
/// parsed into Dart. Mirrors the API engine's JSON Schema subset
/// (apps/api/src/categories/field-schema/field-schema.types.ts); the parity
/// test against test/fixtures/validation-cases.json keeps the two honest.
library;

enum FieldType {
  text,
  textarea,
  number,
  money,
  bool,
  select,
  multiselect,
  date,
  phone;

  static FieldType parse(String value) => switch (value) {
    'text' => text,
    'textarea' => textarea,
    'number' => number,
    'money' => money,
    'bool' => bool,
    'select' => select,
    'multiselect' => multiselect,
    'date' => date,
    'phone' => phone,
    _ => throw FormatException('Unknown x-field-type: $value'),
  };
}

/// Show the field only while [field] holds one of [values] (strings or bools).
class ShowWhen {
  const ShowWhen({required this.field, required this.values});

  factory ShowWhen.fromJson(Map<String, dynamic> json) => ShowWhen(
    field: json['field'] as String,
    values: List<Object>.from(json['in'] as List),
  );

  final String field;
  final List<Object> values;
}

class FieldProperty {
  const FieldProperty({
    required this.type,
    this.integer = false,
    this.maxLength,
    this.pattern,
    this.format,
    this.minimum,
    this.exclusiveMinimum,
    this.maximum,
    this.maxCurrentYearOffset,
    this.gteField,
    this.moneyMin,
    this.moneyMax,
    this.options = const [],
    this.minItems,
    this.notBeforeToday = false,
    this.showWhen,
  });

  factory FieldProperty.fromJson(Map<String, dynamic> json) {
    final type = FieldType.parse(json['x-field-type'] as String);
    final items = json['items'] as Map<String, dynamic>?;
    final showWhen = json['x-show-when'] as Map<String, dynamic>?;
    return FieldProperty(
      type: type,
      integer: json['type'] == 'integer',
      maxLength: json['maxLength'] as int?,
      pattern: json['pattern'] as String?,
      format: json['format'] as String?,
      minimum: json['minimum'] as num?,
      exclusiveMinimum: json['exclusiveMinimum'] as num?,
      maximum: json['maximum'] as num?,
      maxCurrentYearOffset: json['x-max-current-year-offset'] as int?,
      gteField: json['x-gte-field'] as String?,
      moneyMin: json['x-money-min'] as String?,
      moneyMax: json['x-money-max'] as String?,
      options: List<String>.from(
        (json['enum'] ?? items?['enum'] ?? const <String>[]) as List,
      ),
      minItems: json['minItems'] as int?,
      notBeforeToday: json['x-not-before-today'] == true,
      showWhen: showWhen == null ? null : ShowWhen.fromJson(showWhen),
    );
  }

  final FieldType type;

  /// Number fields: whole numbers only.
  final bool integer;
  final int? maxLength;
  final String? pattern;

  /// Text fields: `uri` for https links.
  final String? format;
  final num? minimum;
  final num? exclusiveMinimum;
  final num? maximum;
  final int? maxCurrentYearOffset;
  final String? gteField;
  final String? moneyMin;
  final String? moneyMax;

  /// Select / multiselect option codes, in order.
  final List<String> options;
  final int? minItems;
  final bool notBeforeToday;
  final ShowWhen? showWhen;
}

class ConditionalRule {
  const ConditionalRule({
    required this.ifEnum,
    required this.ifRequired,
    required this.thenRequired,
  });

  factory ConditionalRule.fromJson(Map<String, dynamic> json) {
    final condition = json['if'] as Map<String, dynamic>;
    final properties =
        (condition['properties'] as Map<String, dynamic>?) ?? const {};
    return ConditionalRule(
      ifEnum: {
        for (final entry in properties.entries)
          entry.key: List<String>.from(
            (entry.value as Map<String, dynamic>)['enum'] as List,
          ),
      },
      ifRequired: List<String>.from(condition['required'] as List),
      thenRequired: List<String>.from(
        (json['then'] as Map<String, dynamic>)['required'] as List,
      ),
    );
  }

  final Map<String, List<String>> ifEnum;
  final List<String> ifRequired;
  final List<String> thenRequired;
}

class LocalizedText {
  const LocalizedText(this.bn, this.en);

  factory LocalizedText.fromJson(Map<String, dynamic> json) =>
      LocalizedText(json['bn'] as String, json['en'] as String);

  final String bn;
  final String en;

  String of(String locale) => locale == 'en' ? en : bn;
}

/// One version of a category's fields.
class CategoryFieldSchema {
  const CategoryFieldSchema({
    required this.properties,
    required this.required,
    required this.allOf,
    required this.order,
    required this.card,
    required this.hidden,
    required this.labels,
    required this.optionLabels,
    required this.filterableFields,
    required this.searchableFields,
  });

  /// From GET /categories' `fieldSchema` object.
  factory CategoryFieldSchema.fromJson(Map<String, dynamic> json) {
    final jsonSchema = json['jsonSchema'] as Map<String, dynamic>;
    final ui = json['uiSchema'] as Map<String, dynamic>;
    final options = (ui['options'] as Map<String, dynamic>?) ?? const {};
    return CategoryFieldSchema(
      properties: {
        for (final entry
            in (jsonSchema['properties'] as Map<String, dynamic>).entries)
          entry.key: FieldProperty.fromJson(
            entry.value as Map<String, dynamic>,
          ),
      },
      required: List<String>.from(jsonSchema['required'] as List),
      allOf: [
        for (final rule in (jsonSchema['allOf'] as List?) ?? const [])
          ConditionalRule.fromJson(rule as Map<String, dynamic>),
      ],
      order: List<String>.from(ui['order'] as List),
      card: List<String>.from(ui['card'] as List),
      hidden: List<String>.from((ui['hidden'] as List?) ?? const []),
      labels: {
        for (final entry in (ui['labels'] as Map<String, dynamic>).entries)
          entry.key: LocalizedText.fromJson(
            entry.value as Map<String, dynamic>,
          ),
      },
      optionLabels: {
        for (final field in options.entries)
          field.key: {
            for (final option in (field.value as Map<String, dynamic>).entries)
              option.key: LocalizedText.fromJson(
                option.value as Map<String, dynamic>,
              ),
          },
      },
      filterableFields: List<String>.from(
        (json['filterableFields'] as List?) ?? const [],
      ),
      searchableFields: List<String>.from(
        (json['searchableFields'] as List?) ?? const [],
      ),
    );
  }

  final Map<String, FieldProperty> properties;
  final List<String> required;
  final List<ConditionalRule> allOf;
  final List<String> order;
  final List<String> card;
  final List<String> hidden;
  final Map<String, LocalizedText> labels;
  final Map<String, Map<String, LocalizedText>> optionLabels;
  final List<String> filterableFields;
  final List<String> searchableFields;

  /// Fields a form shows, in display order (ui order, minus hidden inherited ones).
  List<String> get formFieldKeys => [
    for (final key in order)
      if (properties.containsKey(key) && !hidden.contains(key)) key,
  ];

  String label(String key, String locale) => labels[key]?.of(locale) ?? key;

  String optionLabel(String key, String code, String locale) =>
      optionLabels[key]?[code]?.of(locale) ?? code;

  /// Required outright, or while visible for an `x-show-when` field.
  bool isRequired(String key) => required.contains(key);
}

/// A category as GET /categories serves it (the fixtures have the same shape).
class CategorySchemaEntry {
  const CategorySchemaEntry({
    required this.slug,
    required this.name,
    required this.schema,
  });

  factory CategorySchemaEntry.fromJson(Map<String, dynamic> json) =>
      CategorySchemaEntry(
        slug: json['slug'] as String,
        name: LocalizedText.fromJson(json['name'] as Map<String, dynamic>),
        schema: CategoryFieldSchema.fromJson(
          json['fieldSchema'] as Map<String, dynamic>,
        ),
      );

  final String slug;
  final LocalizedText name;
  final CategoryFieldSchema schema;
}
