import 'package:flutter/material.dart';

/// `categories.icon_key` (Lucide names, from the seed taxonomy) as a
/// Material icon. An unknown key still gets a sensible generic icon, so a
/// category added on the server never shows a blank tile.
IconData categoryIcon(String? iconKey) => switch (iconKey) {
  'key-round' => Icons.key_outlined,
  'car-front' => Icons.directions_car_outlined,
  'car-taxi-front' => Icons.local_taxi_outlined,
  'smartphone' => Icons.smartphone_outlined,
  'sofa' => Icons.chair_outlined,
  'shirt' => Icons.checkroom_outlined,
  'shopping-bag' => Icons.shopping_bag_outlined,
  'shopping-basket' => Icons.shopping_basket_outlined,
  'store' => Icons.storefront_outlined,
  'briefcase' => Icons.work_outline,
  'wrench' || 'hammer' => Icons.build_outlined,
  'brick-wall' => Icons.foundation_outlined,
  'scissors' => Icons.content_cut,
  'utensils' || 'cooking-pot' => Icons.restaurant_outlined,
  'graduation-cap' || 'school' => Icons.school_outlined,
  'stethoscope' => Icons.medical_services_outlined,
  'pill' => Icons.medication_outlined,
  'cow' => Icons.pets_outlined,
  'sprout' => Icons.grass_outlined,
  'party-popper' => Icons.celebration_outlined,
  'landmark' => Icons.account_balance_outlined,
  'droplet' => Icons.water_drop_outlined,
  'flame' => Icons.local_fire_department_outlined,
  'siren' => Icons.emergency_outlined,
  _ => Icons.category_outlined,
};
