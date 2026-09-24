/**
 * The 26 categories from docs/specs/categories.md, in code. Keep the two in
 * sync by hand — this file has no generator, categories.md is the
 * human-readable source of truth and this is its TypeScript mirror (same
 * relationship as docs/specs/schema.md and src/database/schema).
 */

export type CategoryKind = 'marketplace' | 'rental' | 'job' | 'service' | 'place';

/** Informational only — not a database column. See categories.md "Monetization mode". */
export type MonetizationMode = 'subscription' | 'boost' | 'per_listing' | 'lead_fee' | 'free';

type FieldType = 'string' | 'integer' | 'number' | 'boolean' | 'array';

interface FieldDef {
  type: FieldType;
  enum?: string[];
  required?: boolean;
  /** Only for type: 'array' — the item type. */
  items?: 'string';
}

export interface CategoryDef {
  slug: string;
  kind: CategoryKind;
  nameBn: string;
  nameEn: string;
  costCredits: number;
  moderationMode: 'pre' | null;
  monetizationMode: MonetizationMode;
  fields: Record<string, FieldDef>;
  /** Enum-typed fields exposed as search facets. */
  filterableFields: string[];
  /** Scrub whitelist (§13.31) — non-identifying fields kept after a privacy scrub. */
  analyticsFields: string[];
}

function field(type: FieldType, opts: Omit<FieldDef, 'type'> = {}): FieldDef {
  return { type, ...opts };
}

export const CATEGORIES: CategoryDef[] = [
  // ---- Marketplace (10) --------------------------------------------------
  {
    slug: 'mobile-phones',
    kind: 'marketplace',
    nameBn: 'মোবাইল ও ট্যাব',
    nameEn: 'Mobile Phones & Tablets',
    costCredits: 3,
    moderationMode: 'pre',
    monetizationMode: 'per_listing',
    fields: {
      brand: field('string', {
        enum: ['Samsung', 'Apple', 'Xiaomi', 'Realme', 'Oppo', 'Vivo', 'OnePlus', 'Other'],
        required: true,
      }),
      model: field('string', { required: true }),
      condition: field('string', {
        enum: ['new', 'like_new', 'used', 'for_parts'],
        required: true,
      }),
      storage_gb: field('integer'),
      price: field('number', { required: true }),
    },
    filterableFields: ['brand', 'condition'],
    analyticsFields: ['brand', 'model', 'condition'],
  },
  {
    slug: 'electronics-appliances',
    kind: 'marketplace',
    nameBn: 'ইলেকট্রনিক্স ও যন্ত্রপাতি',
    nameEn: 'Electronics & Appliances',
    costCredits: 3,
    moderationMode: null,
    monetizationMode: 'per_listing',
    fields: {
      item_type: field('string', {
        enum: ['tv', 'fridge', 'ac', 'washing_machine', 'laptop', 'camera', 'other'],
        required: true,
      }),
      brand: field('string'),
      condition: field('string', { enum: ['new', 'used'], required: true }),
      warranty_months: field('integer'),
      price: field('number', { required: true }),
    },
    filterableFields: ['item_type', 'condition'],
    analyticsFields: ['item_type', 'brand', 'condition'],
  },
  {
    slug: 'furniture-home',
    kind: 'marketplace',
    nameBn: 'আসবাবপত্র ও গৃহস্থালি',
    nameEn: 'Furniture & Home',
    costCredits: 2,
    moderationMode: null,
    monetizationMode: 'per_listing',
    fields: {
      item_type: field('string', {
        enum: ['sofa', 'bed', 'table', 'chair', 'wardrobe', 'other'],
        required: true,
      }),
      material: field('string'),
      condition: field('string', { enum: ['new', 'used'], required: true }),
      price: field('number', { required: true }),
    },
    filterableFields: ['item_type', 'condition'],
    analyticsFields: ['item_type', 'condition'],
  },
  {
    slug: 'cars',
    kind: 'marketplace',
    nameBn: 'গাড়ি ও জিপ',
    nameEn: 'Cars & Jeeps',
    costCredits: 1,
    moderationMode: null,
    monetizationMode: 'boost',
    fields: {
      brand: field('string', { required: true }),
      model: field('string', { required: true }),
      year: field('integer', { required: true }),
      fuel_type: field('string', {
        enum: ['petrol', 'diesel', 'cng', 'electric', 'hybrid'],
        required: true,
      }),
      transmission: field('string', { enum: ['manual', 'automatic'] }),
      mileage_km: field('integer'),
      seats: field('integer'),
      condition: field('string', { enum: ['new', 'used'] }),
      price: field('number', { required: true }),
    },
    filterableFields: ['brand', 'fuel_type', 'transmission'],
    analyticsFields: ['brand', 'model', 'year', 'fuel_type', 'condition'],
  },
  {
    slug: 'motorcycles',
    kind: 'marketplace',
    nameBn: 'মোটরসাইকেল ও স্কুটার',
    nameEn: 'Motorcycles & Scooters',
    costCredits: 1,
    moderationMode: null,
    monetizationMode: 'boost',
    fields: {
      brand: field('string', { required: true }),
      model: field('string', { required: true }),
      year: field('integer'),
      engine_cc: field('integer', { required: true }),
      condition: field('string', { enum: ['new', 'used'] }),
      price: field('number', { required: true }),
    },
    filterableFields: ['brand', 'engine_cc'],
    analyticsFields: ['brand', 'model', 'year', 'engine_cc'],
  },
  {
    slug: 'fashion-clothing',
    kind: 'marketplace',
    nameBn: 'ফ্যাশন ও পোশাক',
    nameEn: 'Fashion & Clothing',
    costCredits: 2,
    moderationMode: null,
    monetizationMode: 'per_listing',
    fields: {
      item_type: field('string', {
        enum: ['mens', 'womens', 'kids', 'footwear', 'accessories'],
        required: true,
      }),
      size: field('string'),
      condition: field('string', { enum: ['new', 'used'] }),
      price: field('number', { required: true }),
    },
    filterableFields: ['item_type', 'condition'],
    analyticsFields: ['item_type', 'condition'],
  },
  {
    slug: 'books-hobbies',
    kind: 'marketplace',
    nameBn: 'বই, খেলাধুলা ও শখ',
    nameEn: 'Books, Sports & Hobbies',
    costCredits: 2,
    moderationMode: null,
    monetizationMode: 'per_listing',
    fields: {
      item_type: field('string', {
        enum: ['books', 'sports_equipment', 'musical_instruments', 'toys', 'other'],
        required: true,
      }),
      condition: field('string', { enum: ['new', 'used'] }),
      price: field('number', { required: true }),
    },
    filterableFields: ['item_type', 'condition'],
    analyticsFields: ['item_type', 'condition'],
  },
  {
    slug: 'livestock-pets',
    kind: 'marketplace',
    nameBn: 'গবাদি পশু ও পোষা প্রাণী',
    nameEn: 'Livestock & Pets',
    costCredits: 1,
    moderationMode: 'pre',
    monetizationMode: 'boost',
    fields: {
      animal_type: field('string', {
        enum: ['cow', 'goat', 'poultry', 'fish', 'dog', 'cat', 'bird', 'other'],
        required: true,
      }),
      age_months: field('integer'),
      breed: field('string'),
      price: field('number', { required: true }),
    },
    filterableFields: ['animal_type'],
    analyticsFields: ['animal_type', 'breed'],
  },
  {
    slug: 'property-sale',
    kind: 'marketplace',
    nameBn: 'সম্পত্তি বিক্রয়',
    nameEn: 'Property for Sale',
    costCredits: 1,
    moderationMode: 'pre',
    monetizationMode: 'boost',
    fields: {
      property_type: field('string', {
        enum: ['apartment', 'house', 'commercial', 'land'],
        required: true,
      }),
      bedrooms: field('integer'),
      bathrooms: field('integer'),
      area: field('number', { required: true }),
      floor: field('integer'),
      price: field('number', { required: true }),
    },
    filterableFields: ['property_type'],
    analyticsFields: ['property_type', 'bedrooms', 'area'],
  },
  {
    slug: 'land-sale',
    kind: 'marketplace',
    nameBn: 'জমি বিক্রয়',
    nameEn: 'Land for Sale',
    costCredits: 1,
    moderationMode: 'pre',
    monetizationMode: 'boost',
    fields: {
      land_type: field('string', {
        enum: ['residential', 'agricultural', 'commercial'],
        required: true,
      }),
      area: field('number', { required: true }),
      area_unit: field('string', { enum: ['katha', 'bigha', 'acre', 'decimal'], required: true }),
      price: field('number', { required: true }),
    },
    filterableFields: ['land_type', 'area_unit'],
    analyticsFields: ['land_type', 'area'],
  },

  // ---- Rental (4) ---------------------------------------------------------
  {
    slug: 'apartments-rent',
    kind: 'rental',
    nameBn: 'বাসা ও ফ্ল্যাট ভাড়া',
    nameEn: 'Apartments & Houses for Rent',
    costCredits: 0,
    moderationMode: 'pre',
    monetizationMode: 'subscription',
    fields: {
      bedrooms: field('integer', { required: true }),
      bathrooms: field('integer'),
      area: field('number'),
      floor: field('integer'),
      furnished: field('boolean'),
      advance_months: field('integer'),
      price: field('number', { required: true }),
    },
    filterableFields: ['bedrooms', 'furnished'],
    analyticsFields: ['bedrooms', 'area', 'furnished'],
  },
  {
    slug: 'rooms-mess-rent',
    kind: 'rental',
    nameBn: 'রুম ও মেস ভাড়া',
    nameEn: 'Rooms & Mess for Rent',
    costCredits: 0,
    moderationMode: null,
    monetizationMode: 'subscription',
    fields: {
      room_type: field('string', { enum: ['single', 'shared', 'mess'], required: true }),
      gender_preference: field('string', { enum: ['male', 'female', 'any'] }),
      attached_bathroom: field('boolean'),
      price: field('number', { required: true }),
    },
    filterableFields: ['room_type', 'gender_preference'],
    analyticsFields: ['room_type'],
  },
  {
    slug: 'land-commercial-rent',
    kind: 'rental',
    nameBn: 'জমি ও বাণিজ্যিক স্থান ভাড়া',
    nameEn: 'Land & Commercial Space for Rent',
    costCredits: 0,
    moderationMode: 'pre',
    monetizationMode: 'subscription',
    fields: {
      space_type: field('string', {
        enum: ['shop', 'office', 'warehouse', 'land'],
        required: true,
      }),
      area: field('number', { required: true }),
      price: field('number', { required: true }),
    },
    filterableFields: ['space_type'],
    analyticsFields: ['space_type', 'area'],
  },
  {
    slug: 'tools-equipment-rent',
    kind: 'rental',
    nameBn: 'যন্ত্রপাতি ভাড়া',
    nameEn: 'Tools & Equipment Rental',
    costCredits: 0,
    moderationMode: null,
    monetizationMode: 'subscription',
    fields: {
      item_type: field('string', {
        enum: ['construction', 'agricultural', 'event', 'generator', 'other'],
        required: true,
      }),
      rental_period: field('string', { enum: ['hourly', 'daily', 'weekly'], required: true }),
      price: field('number', { required: true }),
    },
    filterableFields: ['item_type', 'rental_period'],
    analyticsFields: ['item_type'],
  },

  // ---- Job (3) --------------------------------------------------------------
  {
    slug: 'jobs-fulltime',
    kind: 'job',
    nameBn: 'পূর্ণকালীন চাকরি',
    nameEn: 'Full-Time Jobs',
    costCredits: 0,
    moderationMode: 'pre',
    monetizationMode: 'free',
    fields: {
      job_title: field('string', { required: true }),
      company_name: field('string'),
      salary_min: field('number'),
      salary_max: field('number'),
      experience_years: field('integer'),
      education_level: field('string', { enum: ['ssc', 'hsc', 'graduate', 'masters', 'any'] }),
    },
    filterableFields: ['education_level'],
    analyticsFields: ['job_title'],
  },
  {
    slug: 'jobs-parttime',
    kind: 'job',
    nameBn: 'খণ্ডকালীন ও দৈনিক কাজ',
    nameEn: 'Part-Time & Daily Labor',
    costCredits: 0,
    moderationMode: 'pre',
    monetizationMode: 'free',
    fields: {
      job_title: field('string', { required: true }),
      pay_type: field('string', { enum: ['hourly', 'daily', 'per_task'], required: true }),
      pay_amount: field('number', { required: true }),
    },
    filterableFields: ['pay_type'],
    analyticsFields: ['job_title', 'pay_type'],
  },
  {
    slug: 'jobs-tuition',
    kind: 'job',
    nameBn: 'টিউশন ও শিক্ষকতা',
    nameEn: 'Tuition & Teaching Jobs',
    costCredits: 0,
    moderationMode: 'pre',
    monetizationMode: 'free',
    fields: {
      subject: field('string', { required: true }),
      class_level: field('string', {
        enum: ['primary', 'secondary', 'higher_secondary', 'university'],
        required: true,
      }),
      mode: field('string', { enum: ['home', 'online', 'both'], required: true }),
      pay_amount: field('number'),
    },
    filterableFields: ['class_level', 'mode'],
    analyticsFields: ['subject', 'class_level'],
  },

  // ---- Service (5) ------------------------------------------------------------
  {
    slug: 'home-repair-services',
    kind: 'service',
    nameBn: 'বাসাবাড়ি মেরামত সেবা',
    nameEn: 'Home & Repair Services',
    costCredits: 0,
    moderationMode: null,
    monetizationMode: 'lead_fee',
    fields: {
      service_type: field('string', {
        enum: ['electrician', 'plumber', 'carpenter', 'painter', 'ac_repair', 'other'],
        required: true,
      }),
      experience_years: field('integer'),
      price: field('number'),
    },
    filterableFields: ['service_type'],
    analyticsFields: ['service_type'],
  },
  {
    slug: 'tutoring-services',
    kind: 'service',
    nameBn: 'টিউটরিং ও শিক্ষা সেবা',
    nameEn: 'Tutoring & Education Services',
    costCredits: 0,
    moderationMode: null,
    monetizationMode: 'lead_fee',
    fields: {
      subject: field('string', { required: true }),
      level: field('string', {
        enum: ['primary', 'secondary', 'higher_secondary', 'university', 'professional'],
        required: true,
      }),
      mode: field('string', { enum: ['home', 'online', 'both'] }),
      price: field('number'),
    },
    filterableFields: ['subject', 'level', 'mode'],
    analyticsFields: ['subject', 'level'],
  },
  {
    slug: 'event-catering-services',
    kind: 'service',
    nameBn: 'অনুষ্ঠান ও ক্যাটারিং সেবা',
    nameEn: 'Event & Catering Services',
    costCredits: 0,
    moderationMode: null,
    monetizationMode: 'lead_fee',
    fields: {
      service_type: field('string', {
        enum: ['catering', 'decoration', 'photography', 'venue', 'other'],
        required: true,
      }),
      min_guests: field('integer'),
      price: field('number'),
    },
    filterableFields: ['service_type'],
    analyticsFields: ['service_type'],
  },
  {
    slug: 'beauty-wellness-services',
    kind: 'service',
    nameBn: 'রূপচর্চা ও সুস্থতা সেবা',
    nameEn: 'Beauty & Wellness Services',
    costCredits: 0,
    moderationMode: null,
    monetizationMode: 'lead_fee',
    fields: {
      service_type: field('string', {
        enum: ['salon', 'spa', 'fitness_trainer', 'yoga', 'other'],
        required: true,
      }),
      home_service: field('boolean'),
      price: field('number'),
    },
    filterableFields: ['service_type', 'home_service'],
    analyticsFields: ['service_type'],
  },
  {
    slug: 'transport-courier-services',
    kind: 'service',
    nameBn: 'পরিবহন ও কুরিয়ার সেবা',
    nameEn: 'Transport & Courier Services',
    costCredits: 0,
    moderationMode: null,
    monetizationMode: 'lead_fee',
    fields: {
      service_type: field('string', {
        enum: ['ride', 'courier', 'moving', 'rental_driver', 'other'],
        required: true,
      }),
      vehicle_type: field('string', { enum: ['car', 'cng', 'bike', 'truck', 'any'] }),
      price: field('number'),
    },
    filterableFields: ['service_type', 'vehicle_type'],
    analyticsFields: ['service_type'],
  },

  // ---- Place: business directory (4) -------------------------------------
  {
    slug: 'restaurants',
    kind: 'place',
    nameBn: 'রেস্তোরাঁ ও খাবার',
    nameEn: 'Restaurants & Food',
    costCredits: 0,
    moderationMode: null,
    monetizationMode: 'free',
    fields: {
      cuisine: field('string', {
        enum: ['bengali', 'chinese', 'fast_food', 'bakery', 'indian', 'other'],
        required: true,
      }),
      price_range: field('string', { enum: ['budget', 'mid', 'premium'] }),
      delivery_available: field('boolean'),
    },
    filterableFields: ['cuisine', 'price_range'],
    analyticsFields: ['cuisine'],
  },
  {
    slug: 'grocery-kirana',
    kind: 'place',
    nameBn: 'মুদি ও কিরানা দোকান',
    nameEn: 'Grocery & Kirana Shops',
    costCredits: 0,
    moderationMode: null,
    monetizationMode: 'free',
    fields: {
      shop_type: field('string', {
        enum: ['grocery', 'kirana', 'supershop', 'other'],
        required: true,
      }),
      delivery_available: field('boolean'),
    },
    filterableFields: ['shop_type'],
    analyticsFields: ['shop_type'],
  },
  {
    slug: 'pharmacies',
    kind: 'place',
    nameBn: 'ফার্মেসি',
    nameEn: 'Pharmacies',
    costCredits: 0,
    moderationMode: null,
    monetizationMode: 'free',
    fields: {
      is_24_hours: field('boolean'),
      home_delivery: field('boolean'),
    },
    filterableFields: ['is_24_hours'],
    analyticsFields: [],
  },
  {
    slug: 'clinics-hospitals',
    kind: 'place',
    nameBn: 'ক্লিনিক ও হাসপাতাল',
    nameEn: 'Clinics & Hospitals',
    costCredits: 0,
    moderationMode: null,
    monetizationMode: 'free',
    fields: {
      facility_type: field('string', {
        enum: ['clinic', 'hospital', 'diagnostic_center', 'dental'],
        required: true,
      }),
      specialties: field('array', { items: 'string' }),
      emergency_available: field('boolean'),
    },
    filterableFields: ['facility_type', 'emergency_available'],
    analyticsFields: ['facility_type'],
  },
];

if (CATEGORIES.length !== 26) {
  throw new Error(`Expected exactly 26 categories, found ${CATEGORIES.length}`);
}

/** Builds the JSON Schema `category_field_schemas.json_schema` for a category. */
export function toJsonSchema(def: CategoryDef): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, f] of Object.entries(def.fields)) {
    const type = f.type === 'array' ? 'array' : f.type;
    properties[name] =
      f.type === 'array'
        ? { type, items: { type: f.items ?? 'string' } }
        : f.enum
          ? { type, enum: f.enum }
          : { type };
    if (f.required) required.push(name);
  }
  return { type: 'object', properties, required };
}
