import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:amar_elaka_app/core/map/geo_api.dart';
import 'package:amar_elaka_app/core/network/api_exception.dart';

/// GET /map/config as the API seeds it (migration 0041): the eight Map tab
/// kinds and the client timings.
const testMapConfig = MapConfig(
  tiles: null,
  assetsBaseUrl: 'http://tiles.test/tiles',
  labelLanguage: 'en',
  kinds: [
    MapKind(
      code: 'hospital',
      icon: 'hospital',
      label: MapKindLabel(bn: 'হাসপাতাল', en: 'Hospitals'),
    ),
    MapKind(
      code: 'pharmacy',
      icon: 'pharmacy',
      label: MapKindLabel(bn: 'ফার্মেসি', en: 'Pharmacies'),
    ),
    MapKind(
      code: 'food',
      icon: 'food',
      label: MapKindLabel(bn: 'খাবার', en: 'Food'),
    ),
    MapKind(
      code: 'gas',
      icon: 'gas',
      label: MapKindLabel(bn: 'গ্যাস', en: 'Gas'),
    ),
    MapKind(
      code: 'bank',
      icon: 'bank',
      label: MapKindLabel(bn: 'ব্যাংক ও এটিএম', en: 'Banks & ATMs'),
    ),
    MapKind(
      code: 'bus_stand',
      icon: 'bus',
      label: MapKindLabel(bn: 'বাস স্ট্যান্ড', en: 'Bus stands'),
    ),
    MapKind(
      code: 'shops',
      icon: 'shop',
      label: MapKindLabel(bn: 'দোকান', en: 'Shops'),
    ),
    MapKind(
      code: 'listings',
      icon: 'listing',
      label: MapKindLabel(bn: 'বিজ্ঞাপন', en: 'Listings'),
    ),
  ],
  client: MapClientConfig(
    pickerIdleDebounceMs: 600,
    autocompleteDebounceMs: 400,
    autocompleteMinChars: 3,
    searchAreaMoveRatio: 0.3,
    pinLabelMinZoom: 17,
    pinLabelMax: 40,
  ),
);

/// Our own areas at a point (`/locations/lookup`), country first.
const mirpurAreas = [
  GeoArea(
    id: 'bd',
    level: 'country',
    name: GeoAreaName(bn: 'বাংলাদেশ', en: 'Bangladesh'),
  ),
  GeoArea(
    id: 'dhaka-div',
    level: 'division',
    name: GeoAreaName(bn: 'ঢাকা বিভাগ', en: 'Dhaka Division'),
  ),
  GeoArea(
    id: 'dhaka',
    level: 'district',
    name: GeoAreaName(bn: 'ঢাকা', en: 'Dhaka'),
  ),
  GeoArea(
    id: 'mirpur',
    level: 'upazila',
    name: GeoAreaName(bn: 'মিরপুর', en: 'Mirpur'),
  ),
];

/// The app's side of the geo endpoints, answering what the API answers with
/// its FakeProvider standing in for Barikoi
/// (apps/api/src/locations/geocoding/providers/fake.provider.ts): the same
/// address and suggestion. Records every call, fails on demand.
class FakeGeoApi implements GeoApi {
  final reverseCalls = <({double lat, double lng, String purpose})>[];
  final areaCalls = <({double lat, double lng})>[];
  final autocompleteCalls = <String>[];

  /// FakeProvider.address; null = the provider knew no street here.
  GeoAddress? address = const GeoAddress(
    label: 'House 8, Road 2, Mirpur, Dhaka',
    labelBn: 'বাড়ি ৮, রোড ২, মিরপুর, ঢাকা',
    area: 'Mirpur',
    city: 'Dhaka',
    postCode: '1216',
  );

  /// FakeProvider.suggestions, after one of our own places.
  List<GeocodeResult> results = const [
    GeocodeResult(
      label: 'Mirpur Stadium',
      labelBn: 'মিরপুর স্টেডিয়াম',
      location: LatLng(lat: 23.8066, lng: 90.3634),
      area: 'Mirpur',
      city: 'Dhaka',
      source: 'own',
      distanceMeters: null,
      kind: 'place',
    ),
    GeocodeResult(
      label: 'Mirpur 10, Dhaka',
      labelBn: 'মিরপুর ১০, ঢাকা',
      location: LatLng(lat: 23.8069, lng: 90.3687),
      area: 'Mirpur',
      city: 'Dhaka',
      source: 'barikoi',
      distanceMeters: null,
    ),
  ];

  /// How long the street address takes (the area answers at once).
  Duration reverseDelay = Duration.zero;

  /// Thrown by reverse (and autocomplete) until cleared.
  AppException? reverseError;

  /// Thrown by areasAt until cleared.
  AppException? areasError;

  @override
  Future<PointAreas> areasAt(double lat, double lng) async {
    areaCalls.add((lat: lat, lng: lng));
    if (areasError case final error?) throw error;
    return const PointAreas(areas: mirpurAreas);
  }

  @override
  Future<ReverseGeocode> reverse(
    double lat,
    double lng, {
    required String purpose,
  }) async {
    reverseCalls.add((lat: lat, lng: lng, purpose: purpose));
    if (reverseDelay > Duration.zero) await Future<void>.delayed(reverseDelay);
    if (reverseError case final error?) throw error;
    return ReverseGeocode(
      location: LatLng(lat: lat, lng: lng),
      purpose: purpose,
      address: address,
      areas: mirpurAreas,
      degraded: false,
    );
  }

  @override
  Future<GeocodeResponse> autocomplete(
    String query, {
    double? lat,
    double? lng,
  }) async {
    autocompleteCalls.add(query);
    if (reverseError case final error?) throw error;
    return GeocodeResponse(query: query, results: results, degraded: false);
  }
}
