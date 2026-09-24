/// Elevation scale (dp), used as `Material.elevation`/`Card.elevation`
/// values. Named by role rather than a raw number at call sites.
abstract final class AppElevation {
  static const double flat = 0;
  static const double raised = 1;
  static const double card = 2;
  static const double overlay = 6;
  static const double modal = 12;
}
