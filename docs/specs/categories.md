# Categories

The platform's global category taxonomy (`categories` + `category_field_schemas`,
docs/specs/schema.md §3.3-3.4). 26 categories, flat (no parents — `depth = 0`
everywhere), covering all five `category_kinds`: `marketplace`, `rental`,
`job`, `service`, `place`. This is the source of truth the seed script
(`apps/api/src/database/seed/data/categories.ts`) encodes in TypeScript;
keep the two in sync by hand (there's no generator).

## Monetization mode

**Not a database column.** The schema has no `categories.monetization_mode`
— pricing is expressed through the columns that already exist
(`default_post_cost_credits`, boost pricing in `tenant_boost_prices`,
subscription plans in `subscription_plans`, lead-based billing being a
future concern with no table yet). "Monetization mode" below is
informational metadata recorded here and in the seed data only, describing
which lever is the category's _primary_ revenue mechanism, so product and
seed data stay consistent. Five modes, distributed across the 26 categories:

| Mode           | Meaning                                                         | How it shows up today                                                                     |
| -------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `per_listing`  | Pay credits to publish                                          | `default_post_cost_credits > 0`, no other lever                                           |
| `boost`        | Free (or near-free) to list; sellers pay to get promoted        | `default_post_cost_credits` low/0; category is a natural `boosts`/`ad_bookings` candidate |
| `subscription` | Repeat posters (agents, landlords) pay for a plan, not per post | `default_post_cost_credits = 0`; monetized via `subscription_plans`, not modeled per-post |
| `lead_fee`     | Free to list; revenue is per revealed contact/lead              | `default_post_cost_credits = 0`; monetized via future lead-billing, not modeled yet       |
| `free`         | No monetization                                                 | `default_post_cost_credits = 0`                                                           |

## Moderation mode

`default_moderation_mode_code` is `pre` (pre-moderation) for scam-prone
categories per docs/specs/schema.md §3.3's own examples (mobile phones,
jobs, rentals/property, livestock with advance payment); `null` everywhere
else, meaning "follow the tenant's mode" (`moderation_modes.post` by
default).

## Marketplace (10)

| slug                     | name (en / bn)                                       | cost | moderation | monetization | fields                                                                                                                                                                                                                                                       |
| ------------------------ | ---------------------------------------------------- | ---- | ---------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mobile-phones`          | Mobile Phones & Tablets / মোবাইল ও ট্যাব             | 3    | pre        | per_listing  | `brand` (enum, req), `model` (string, req), `condition` (enum: new/like_new/used/for_parts, req), `storage_gb` (int), `price` (number, req)                                                                                                                  |
| `electronics-appliances` | Electronics & Appliances / ইলেকট্রনিক্স ও যন্ত্রপাতি | 3    | —          | per_listing  | `item_type` (enum: tv/fridge/ac/washing_machine/laptop/camera/other, req), `brand` (string), `condition` (enum: new/used, req), `warranty_months` (int), `price` (number, req)                                                                               |
| `furniture-home`         | Furniture & Home / আসবাবপত্র ও গৃহস্থালি             | 2    | —          | per_listing  | `item_type` (enum: sofa/bed/table/chair/wardrobe/other, req), `material` (string), `condition` (enum: new/used, req), `price` (number, req)                                                                                                                  |
| `cars`                   | Cars & Jeeps / গাড়ি ও জিপ                           | 1    | —          | boost        | `brand` (string, req), `model` (string, req), `year` (int, req), `fuel_type` (enum: petrol/diesel/cng/electric/hybrid, req), `transmission` (enum: manual/automatic), `mileage_km` (int), `seats` (int), `condition` (enum: new/used), `price` (number, req) |
| `motorcycles`            | Motorcycles & Scooters / মোটরসাইকেল ও স্কুটার        | 1    | —          | boost        | `brand` (string, req), `model` (string, req), `year` (int), `engine_cc` (int, req), `condition` (enum: new/used), `price` (number, req)                                                                                                                      |
| `fashion-clothing`       | Fashion & Clothing / ফ্যাশন ও পোশাক                  | 2    | —          | per_listing  | `item_type` (enum: mens/womens/kids/footwear/accessories, req), `size` (string), `condition` (enum: new/used), `price` (number, req)                                                                                                                         |
| `books-hobbies`          | Books, Sports & Hobbies / বই, খেলাধুলা ও শখ          | 2    | —          | per_listing  | `item_type` (enum: books/sports_equipment/musical_instruments/toys/other, req), `condition` (enum: new/used), `price` (number, req)                                                                                                                          |
| `livestock-pets`         | Livestock & Pets / গবাদি পশু ও পোষা প্রাণী           | 1    | pre        | boost        | `animal_type` (enum: cow/goat/poultry/fish/dog/cat/bird/other, req), `age_months` (int), `breed` (string), `price` (number, req)                                                                                                                             |
| `property-sale`          | Property for Sale / সম্পত্তি বিক্রয়                 | 1    | pre        | boost        | `property_type` (enum: apartment/house/commercial/land, req), `bedrooms` (int), `bathrooms` (int), `area` (number, req, sqft), `floor` (int), `price` (number, req)                                                                                          |
| `land-sale`              | Land for Sale / জমি বিক্রয়                          | 1    | pre        | boost        | `land_type` (enum: residential/agricultural/commercial, req), `area` (number, req), `area_unit` (enum: katha/bigha/acre/decimal, req), `price` (number, req)                                                                                                 |

## Rental (4)

| slug                   | name (en / bn)                                                 | cost | moderation | monetization | fields                                                                                                                                                  |
| ---------------------- | -------------------------------------------------------------- | ---- | ---------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apartments-rent`      | Apartments & Houses for Rent / বাসা ও ফ্ল্যাট ভাড়া            | 0    | pre        | subscription | `bedrooms` (int, req), `bathrooms` (int), `area` (number), `floor` (int), `furnished` (boolean), `advance_months` (int), `price` (number, req, monthly) |
| `rooms-mess-rent`      | Rooms & Mess for Rent / রুম ও মেস ভাড়া                        | 0    | —          | subscription | `room_type` (enum: single/shared/mess, req), `gender_preference` (enum: male/female/any), `attached_bathroom` (boolean), `price` (number, req)          |
| `land-commercial-rent` | Land & Commercial Space for Rent / জমি ও বাণিজ্যিক স্থান ভাড়া | 0    | pre        | subscription | `space_type` (enum: shop/office/warehouse/land, req), `area` (number, req), `price` (number, req)                                                       |
| `tools-equipment-rent` | Tools & Equipment Rental / যন্ত্রপাতি ভাড়া                    | 0    | —          | subscription | `item_type` (enum: construction/agricultural/event/generator/other, req), `rental_period` (enum: hourly/daily/weekly, req), `price` (number, req)       |

## Job (3)

| slug            | name (en / bn)                                  | cost | moderation | monetization | fields                                                                                                                                                                             |
| --------------- | ----------------------------------------------- | ---- | ---------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jobs-fulltime` | Full-Time Jobs / পূর্ণকালীন চাকরি               | 0    | pre        | free         | `job_title` (string, req), `company_name` (string), `salary_min` (number), `salary_max` (number), `experience_years` (int), `education_level` (enum: ssc/hsc/graduate/masters/any) |
| `jobs-parttime` | Part-Time & Daily Labor / খণ্ডকালীন ও দৈনিক কাজ | 0    | pre        | free         | `job_title` (string, req), `pay_type` (enum: hourly/daily/per_task, req), `pay_amount` (number, req)                                                                               |
| `jobs-tuition`  | Tuition & Teaching Jobs / টিউশন ও শিক্ষকতা      | 0    | pre        | free         | `subject` (string, req), `class_level` (enum: primary/secondary/higher_secondary/university, req), `mode` (enum: home/online/both, req), `pay_amount` (number)                     |

## Service (5)

| slug                         | name (en / bn)                                        | cost | moderation | monetization | fields                                                                                                                                                      |
| ---------------------------- | ----------------------------------------------------- | ---- | ---------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `home-repair-services`       | Home & Repair Services / বাসাবাড়ি মেরামত সেবা        | 0    | —          | lead_fee     | `service_type` (enum: electrician/plumber/carpenter/painter/ac_repair/other, req), `experience_years` (int), `price` (number)                               |
| `tutoring-services`          | Tutoring & Education Services / টিউটরিং ও শিক্ষা সেবা | 0    | —          | lead_fee     | `subject` (string, req), `level` (enum: primary/secondary/higher_secondary/university/professional, req), `mode` (enum: home/online/both), `price` (number) |
| `event-catering-services`    | Event & Catering Services / অনুষ্ঠান ও ক্যাটারিং সেবা | 0    | —          | lead_fee     | `service_type` (enum: catering/decoration/photography/venue/other, req), `min_guests` (int), `price` (number)                                               |
| `beauty-wellness-services`   | Beauty & Wellness Services / রূপচর্চা ও সুস্থতা সেবা  | 0    | —          | lead_fee     | `service_type` (enum: salon/spa/fitness_trainer/yoga/other, req), `home_service` (boolean), `price` (number)                                                |
| `transport-courier-services` | Transport & Courier Services / পরিবহন ও কুরিয়ার সেবা | 0    | —          | lead_fee     | `service_type` (enum: ride/courier/moving/rental_driver/other, req), `vehicle_type` (enum: car/cng/bike/truck/any), `price` (number)                        |

## Place — business directory (4)

Used by the `places` table, not `posts` (§13.17 — a `place`-kind category is
rejected by `posts_validate_category_and_schema()`). No `default_post_cost_credits`
concept applies (places aren't purchased listings), so all four are `free`.

| slug                | name (en / bn)                               | moderation | fields                                                                                                                                         |
| ------------------- | -------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `restaurants`       | Restaurants & Food / রেস্তোরাঁ ও খাবার       | —          | `cuisine` (enum: bengali/chinese/fast_food/bakery/indian/other, req), `price_range` (enum: budget/mid/premium), `delivery_available` (boolean) |
| `grocery-kirana`    | Grocery & Kirana Shops / মুদি ও কিরানা দোকান | —          | `shop_type` (enum: grocery/kirana/supershop/other, req), `delivery_available` (boolean)                                                        |
| `pharmacies`        | Pharmacies / ফার্মেসি                        | —          | `is_24_hours` (boolean), `home_delivery` (boolean)                                                                                             |
| `clinics-hospitals` | Clinics & Hospitals / ক্লিনিক ও হাসপাতাল     | —          | `facility_type` (enum: clinic/hospital/diagnostic_center/dental, req), `specialties` (array of string), `emergency_available` (boolean)        |

## Conventions

- Every category's `json_schema` is `{ type: 'object', properties: {...},
required: [...] }`. Fields named `price`, `bedrooms`, `seats` or `area`
  line up with `posts`' generated columns of the same name (§4.2) — the DB
  extracts them from `fields` automatically, so they must use exactly those
  keys and a numeric/integer JSON type.
- `filterable_fields` = every enum-typed field (Meilisearch facets).
- `analytics_fields` = the scrub whitelist (§13.31): non-identifying fields
  worth keeping after a privacy scrub, in addition to the always-kept
  `price`/`bedrooms`/`seats`/`area`. Set to the category's enum/numeric
  fields (`brand`, `condition`, `year`, etc.), never free-text fields.
- `default_post_cost_credits`: 1-3 for `per_listing`/`boost` categories
  (higher-value goods cost more to list), 0 everywhere else.
