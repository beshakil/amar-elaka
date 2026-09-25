import { editDistance, matchName, nameKey, upazilaPcodeFromPointCode } from './build-reference';
import { readReference } from './geo-import';

describe('the committed Bangladesh reference (infra/geo/reference)', () => {
  const reference = readReference();
  const byLevel = (level: string) => reference.areas.filter((a) => a.levelCode === level);

  it('has the real administrative units: 8 divisions, 64 districts, 495 upazilas, 12 city corporations', () => {
    expect(byLevel('country')).toHaveLength(1);
    expect(byLevel('division')).toHaveLength(8);
    expect(byLevel('district')).toHaveLength(64);
    expect(byLevel('upazila')).toHaveLength(495);
    expect(byLevel('city_corporation')).toHaveLength(12);
    expect(byLevel('union').length + byLevel('pourashava').length).toBeGreaterThan(4800);
  });

  it('names every division, district, upazila and city corporation in Bengali', () => {
    for (const level of ['country', 'division', 'district', 'upazila', 'city_corporation']) {
      expect(
        byLevel(level)
          .filter((a) => a.nameBn === null)
          .map((a) => a.pcode),
      ).toEqual([]);
    }
    const dhaka = reference.areas.find((a) => a.pcode === 'BD30');
    expect(dhaka).toMatchObject({ nameEn: 'Dhaka', nameBn: 'ঢাকা' });
  });

  it('is a consistent tree keyed by unique pcodes, parents one level up, centres in Bangladesh', () => {
    const byPcode = new Map(reference.areas.map((a) => [a.pcode, a]));
    expect(byPcode.size).toBe(reference.areas.length);
    for (const area of reference.areas) {
      if (area.parentPcode === null) {
        expect(area.admLevel).toBe(0);
        continue;
      }
      const parent = byPcode.get(area.parentPcode);
      expect(parent?.admLevel).toBe(area.admLevel - 1);
      const [lng, lat] = area.center;
      expect(lat).toBeGreaterThan(20.5);
      expect(lat).toBeLessThan(26.7);
      expect(lng).toBeGreaterThan(88);
      expect(lng).toBeLessThan(92.7);
    }
  });

  it('carries its source, licence and attribution', () => {
    expect(reference.licence).toMatch(/CC BY/);
    expect(reference.attribution).toMatch(/Bangladesh Bureau of Statistics/);
    expect(reference.release).toMatch(/COD-AB v03/);
  });
});

describe('Bengali-name matching (build-time only)', () => {
  it('treats common romanisation differences as the same name', () => {
    expect(nameKey('Muktagachha')).toBe(nameKey('Muktagacha'));
    expect(nameKey('Phulpur')).toBe(nameKey('Fulpur'));
    expect(nameKey('Ishwarganj')).toBe(nameKey('Iswarganj'));
    expect(nameKey('Trishal')).not.toBe(nameKey('Bhaluka'));
  });

  it('matches within the parent, and refuses an ambiguous or distant guess', () => {
    const rows = [
      { id: '1', name: 'Bancharampur', bn_name: 'বাঞ্ছারামপুর' },
      { id: '2', name: 'Nabinagar', bn_name: 'নবীনগর' },
    ];
    expect(matchName('Bancharampur', rows)?.how).toBe('exact');
    expect(matchName('Banchharampur', rows)).toMatchObject({ how: 'key', row: { id: '1' } });
    expect(matchName('Kasba', rows)).toBeUndefined();
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });

  it("maps a union point's 2020 upazila code to the 2023 polygon pcode", () => {
    expect(upazilaPcodeFromPointCode('BD456194')).toBe('BD45610094');
  });
});
